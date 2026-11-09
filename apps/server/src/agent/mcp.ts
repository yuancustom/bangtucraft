import { createTool } from "@mastra/core/tools";
import { MCPClient } from "@mastra/mcp";
import { z } from "zod";
import type { Redactor } from "../redact.ts";

export const mcpConfigSchema = z.object({
  servers: z.record(
    z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    z.object({
      url: z.url(),
      /** 工具 schema 声明了 apiKey 参数时，从这个环境变量注入（不暴露给模型）。 */
      apiKeyEnv: z.string().optional(),
      /** 以 Bearer 头鉴权时使用的环境变量。 */
      bearerEnv: z.string().optional(),
      disabled: z.boolean().optional(),
    }),
  ),
});
export type McpConfig = z.infer<typeof mcpConfigSchema>;

const INJECTED = ["apiKey", "messageId"];
const CACHE_TTL_MS = 5 * 60_000;
const RETRY_DELAY_MS = 30_000;

interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export function stripInjected(schema: JsonSchema | undefined): JsonSchema {
  const properties = { ...(schema?.properties ?? {}) };
  for (const key of INJECTED) delete properties[key];
  const required = (schema?.required ?? []).filter((k) => !INJECTED.includes(k));
  const next: JsonSchema = { ...schema, type: "object", properties };
  if (required.length) next.required = required;
  else delete next.required;
  return next;
}

type AnyTool = ReturnType<typeof createTool>;
interface ToolDefinition {
  name?: string;
  description?: string;
  inputSchema?: JsonSchema;
}

export interface McpToolsResult {
  tools: Record<string, AnyTool>;
  failedServers: string[];
  conflicts: string[];
}

/** 把发现到的 MCP 工具包装成 Mastra 工具：去前缀、注入凭据、脱敏输出、同名冲突停用。 */
export function wrapMcpTools(
  toolsets: Record<string, Record<string, AnyTool>>,
  definitions: Record<string, Record<string, ToolDefinition>>,
  options: { config: McpConfig; secrets: Record<string, string>; redactor: Redactor; reservedNames: Set<string> },
): { tools: Record<string, AnyTool>; conflicts: string[] } {
  const owners = new Map<string, string[]>();
  for (const [server, tools] of Object.entries(toolsets)) {
    for (const name of Object.keys(tools)) owners.set(name, [...(owners.get(name) ?? []), server]);
  }
  const wrapped: Record<string, AnyTool> = {};
  const conflicts: string[] = [];
  for (const [name, servers] of owners) {
    if (servers.length !== 1 || options.reservedNames.has(name)) {
      conflicts.push(name);
      continue;
    }
    const serverName = servers[0]!;
    const tool = toolsets[serverName]![name]!;
    const definition = definitions[serverName]?.[name];
    const schema = definition?.inputSchema;
    const props = schema?.properties ?? {};
    const hasApiKey = Object.hasOwn(props, "apiKey");
    const hasMessageId = Object.hasOwn(props, "messageId");
    const apiKeyEnv = options.config.servers[serverName]?.apiKeyEnv;
    const original = tool.execute;
    if (!original) continue;
    wrapped[name] = createTool({
      id: name,
      description: definition?.description ?? tool.description ?? "",
      inputSchema: (hasApiKey || hasMessageId ? stripInjected(schema) : (schema ?? tool.inputSchema)) as never,
      execute: async (input: Record<string, unknown>, context) => {
        const apiKey = hasApiKey && apiKeyEnv ? options.secrets[apiKeyEnv] : undefined;
        if (hasApiKey && !apiKey) return { success: false, error: `MCP 服务 ${serverName} 的凭据未配置，无法执行此工具。` };
        const runId = context?.requestContext?.get("runId");
        const args = {
          ...input,
          ...(hasApiKey ? { apiKey } : {}),
          ...(hasMessageId && typeof runId === "string" ? { messageId: runId } : {}),
        };
        try {
          const result = await original(args as never, context as never);
          return options.redactor.value(result);
        } catch (error) {
          return { success: false, error: options.redactor.error(error).replace(/toolArgs:\s*\{[^}]*\}/g, "") };
        }
      },
    }) as unknown as AnyTool;
  }
  return { tools: wrapped, conflicts };
}

/** MCP 工具目录：并发共享一次发现，成功缓存 5 分钟，失败 30 秒后重试，单服务故障隔离。 */
export class McpCatalog {
  private client: MCPClient | null = null;
  private cached: McpToolsResult | null = null;
  private refreshAfter = 0;
  private inFlight: Promise<McpToolsResult> | null = null;

  constructor(
    private readonly config: McpConfig,
    private readonly secrets: Record<string, string>,
    private readonly redactor: Redactor,
    private readonly reservedNames: Set<string>,
    private readonly now: () => number = Date.now,
  ) {}

  private servers() {
    return Object.fromEntries(Object.entries(this.config.servers).filter(([, s]) => !s.disabled));
  }

  private getClient(): MCPClient | null {
    if (this.client) return this.client;
    const servers = this.servers();
    if (!Object.keys(servers).length) return null;
    this.client = new MCPClient({
      id: `mcp-${Math.random().toString(36).slice(2)}`,
      servers: Object.fromEntries(
        Object.entries(servers).map(([name, s]) => {
          const bearer = s.bearerEnv ? this.secrets[s.bearerEnv] : undefined;
          return [name, { url: new URL(s.url), ...(bearer ? { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } } : {}) }];
        }),
      ),
    });
    return this.client;
  }

  availabilityNote(): string {
    if (!this.cached?.failedServers.length) return "";
    return `MCP 连接状态：服务 ${this.cached.failedServers.join("、")} 暂时连接失败，相关工具不可用。请如实告知用户，不要编造结果。`;
  }

  get(): Promise<McpToolsResult> {
    if (this.inFlight) return this.inFlight;
    if (this.cached && this.now() < this.refreshAfter) return Promise.resolve(this.cached);
    const client = this.getClient();
    if (!client) return Promise.resolve({ tools: {}, failedServers: [], conflicts: [] });
    const pending = this.discover(client).finally(() => {
      if (this.inFlight === pending) this.inFlight = null;
    });
    this.inFlight = pending;
    return pending;
  }

  private async discover(client: MCPClient): Promise<McpToolsResult> {
    const servers = Object.keys(this.servers());
    let result: McpToolsResult;
    try {
      const discovery = { perServerTimeoutMs: 10_000 };
      const [listed, catalog] = await Promise.all([
        client.listToolsetsWithErrors(discovery),
        client.listToolDefinitionsWithErrors(discovery),
      ]);
      const failed = servers.filter(
        (n) => n in listed.errors || n in catalog.errors || !(n in listed.toolsets) || !(n in catalog.definitions),
      );
      const available = Object.fromEntries(Object.entries(listed.toolsets).filter(([n]) => !failed.includes(n)));
      const { tools, conflicts } = wrapMcpTools(
        available as Record<string, Record<string, AnyTool>>,
        catalog.definitions as Record<string, Record<string, ToolDefinition>>,
        { config: this.config, secrets: this.secrets, redactor: this.redactor, reservedNames: this.reservedNames },
      );
      result = { tools, failedServers: failed, conflicts };
    } catch {
      result = { tools: {}, failedServers: servers, conflicts: [] };
    }
    this.cached = result;
    this.refreshAfter = this.now() + (result.failedServers.length ? RETRY_DELAY_MS : CACHE_TTL_MS);
    return result;
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.cached = null;
    this.inFlight = null;
    await client?.disconnect().catch(() => undefined);
  }
}
