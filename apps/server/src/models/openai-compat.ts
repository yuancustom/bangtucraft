// 直接调用 OpenAI 兼容接口（用于 ping、模型发现、轻量分类）。始终用流式，兼容 CodeBuddy。
import type { ModelRegistry } from "./registry.ts";
import type { Redactor } from "../redact.ts";

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export async function streamChat(
  registry: ModelRegistry,
  redactor: Redactor,
  modelId: string,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  options: { maxTokens?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const spec = registry.spec(modelId);
  const started = Date.now();
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60_000);
  let response: Response;
  try {
    response = await fetch(`${spec.url}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${spec.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: spec.modelId,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      }),
      signal,
    });
  } catch (error) {
    throw new Error(`模型 ${modelId} 连接失败：${redactor.error(error)}`);
  }
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(`模型 ${modelId} 返回 HTTP ${response.status}：${redactor.text(body.slice(0, 300))}`);
  }
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string | null } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
          error?: { message?: string };
        };
        if (json.error) throw new Error(json.error.message ?? "模型返回错误");
        text += json.choices?.[0]?.delta?.content ?? "";
        if (json.usage) {
          inputTokens = json.usage.prompt_tokens ?? inputTokens;
          outputTokens = json.usage.completion_tokens ?? outputTokens;
        }
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw new Error(`模型 ${modelId} 流式输出错误：${redactor.error(error)}`);
      }
    }
  }
  return { text, inputTokens, outputTokens, latencyMs: Date.now() - started };
}

/** GET /models，列出接入点可用模型 ID。 */
export async function discoverModels(registry: ModelRegistry, redactor: Redactor, providerId: string): Promise<string[]> {
  const apiKey = registry.apiKey(providerId);
  const response = await fetch(`${registry.baseUrl(providerId)}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  }).catch((error) => {
    throw new Error(`接入点 ${providerId} 连接失败：${redactor.error(error)}`);
  });
  if (!response.ok) throw new Error(`接入点 ${providerId} 返回 HTTP ${response.status}`);
  const body = (await response.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => m.id);
}
