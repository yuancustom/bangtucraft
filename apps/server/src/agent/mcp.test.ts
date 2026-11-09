import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTool } from "@mastra/core/tools";
import { MCPServer } from "@mastra/mcp";
import { z } from "zod";
import { Redactor } from "../redact.ts";
import { McpCatalog, stripInjected } from "./mcp.ts";

const SECRET = "mcp-secret-key-abcdef123456";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function serve(id: string, tools: Record<string, ReturnType<typeof createTool>>) {
  const server = new MCPServer({ id, name: id, version: "1.0.0", tools });
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    await server.startHTTP({ url, httpPath: "/mcp", req, res });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  closers.push(async () => {
    httpServer.closeAllConnections();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await server.close();
  });
  return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
}

describe("stripInjected", () => {
  it("从模型可见 schema 中去掉 apiKey 与 messageId", () => {
    expect(
      stripInjected({ type: "object", properties: { apiKey: {}, messageId: {}, taskId: {} }, required: ["apiKey", "taskId"] }),
    ).toEqual({ type: "object", properties: { taskId: {} }, required: ["taskId"] });
  });
});

describe("McpCatalog（本地 MCP 服务）", () => {
  it("注入 apiKey / messageId、不暴露给模型、输出脱敏、同名冲突停用、故障服务隔离", async () => {
    const seen: Record<string, unknown>[] = [];
    const a = await serve("a", {
      echo_task: createTool({
        id: "echo_task",
        description: "回显任务",
        inputSchema: z.object({ apiKey: z.string(), messageId: z.string().optional(), taskId: z.string() }),
        execute: async (input) => {
          seen.push(input as Record<string, unknown>);
          return { ok: true, leaked: `key=${(input as { apiKey: string }).apiKey}` };
        },
      }),
      dup: createTool({ id: "dup", description: "a", inputSchema: z.object({}), execute: async () => ({}) }),
    });
    const b = await serve("b", {
      dup: createTool({ id: "dup", description: "b", inputSchema: z.object({}), execute: async () => ({}) }),
    });
    const catalog = new McpCatalog(
      {
        servers: {
          a: { url: a, apiKeyEnv: "A_KEY" },
          b: { url: b },
          down: { url: "http://127.0.0.1:1/mcp" },
        },
      },
      { A_KEY: SECRET },
      new Redactor([SECRET]),
      new Set(["present_files"]),
    );
    closers.push(() => catalog.close());
    const result = await catalog.get();
    expect(Object.keys(result.tools)).toEqual(["echo_task"]);
    expect(result.conflicts).toEqual(["dup"]);
    expect(result.failedServers).toEqual(["down"]);
    expect(catalog.availabilityNote()).toContain("down");

    const tool = result.tools.echo_task!;
    const schema = JSON.stringify(tool.inputSchema);
    expect(schema).not.toContain("apiKey");
    expect(schema).not.toContain("messageId");

    const { RequestContext } = await import("@mastra/core/request-context");
    const out = await tool.execute!({ taskId: "t1" } as never, { requestContext: new RequestContext([["runId", "run-123"]]) } as never);
    expect(seen[0]).toMatchObject({ apiKey: SECRET, messageId: "run-123", taskId: "t1" });
    expect(JSON.stringify(out)).not.toContain(SECRET);

    // 缓存：第二次直接返回同一结果对象。
    expect(await catalog.get()).toBe(result);
  }, 60_000);

  it("缺少凭据时不调用服务", async () => {
    let called = false;
    const a = await serve("a", {
      need_key: createTool({
        id: "need_key",
        description: "x",
        inputSchema: z.object({ apiKey: z.string() }),
        execute: async () => {
          called = true;
          return {};
        },
      }),
    });
    const catalog = new McpCatalog({ servers: { a: { url: a, apiKeyEnv: "MISSING" } } }, {}, new Redactor(), new Set());
    closers.push(() => catalog.close());
    const { tools } = await catalog.get();
    const out = await tools.need_key!.execute!({} as never, {} as never);
    expect(out).toMatchObject({ success: false });
    expect(called).toBe(false);
  }, 60_000);
});
