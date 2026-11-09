// 本地假 OpenAI 兼容服务：按脚本返回流式文本、思考或工具调用，并记录请求。
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeReply {
  text?: string;
  reasoning?: string;
  toolCalls?: { name: string; args: unknown; id?: string }[];
  usage?: { prompt: number; completion: number };
  /** 直接返回 HTTP 错误。 */
  status?: number;
  errorBody?: string;
  /** 每个片段之间的延迟（毫秒）。 */
  delayMs?: number;
}

export interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export type FakeScript = (body: Record<string, unknown>, index: number) => FakeReply | Promise<FakeReply>;

export async function startFakeOpenAI(script: FakeScript) {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    requests.push({ path: req.url ?? "", headers: req.headers, body });
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake-a" }, { id: "fake-b" }] }));
      return;
    }
    const reply = await script(body, index++);
    if (reply.status && reply.status >= 400) {
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(reply.errorBody ?? JSON.stringify({ error: { message: "fake error" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const id = `chatcmpl-${index}`;
    const model = String(body.model ?? "fake");
    const send = async (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) => {
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
      );
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    };
    await send({ role: "assistant", content: "" });
    if (reply.reasoning) await send({ reasoning_content: reply.reasoning });
    if (reply.text) {
      for (const piece of reply.text.match(/[\s\S]{1,8}/g) ?? []) await send({ content: piece });
    }
    (reply.toolCalls ?? []).forEach((call, i) => {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 0,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: i, id: call.id ?? `call_${index}_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
    });
    const usage = { prompt_tokens: reply.usage?.prompt ?? 10, completion_tokens: reply.usage?.completion ?? 5, total_tokens: 15 };
    await send({}, reply.toolCalls?.length ? "tool_calls" : "stop", usage);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 构造只含假接入点的模型配置，三个档位分别对应 fake-l1/l2/l3。 */
export function fakeModelsFile(url: string) {
  const model = (id: string, tier: "L1" | "L2" | "L3", images: boolean) => ({
    id,
    name: id,
    provider: "fake",
    tier,
    capabilities: { tools: true, images, reasoning: tier === "L1" },
    contextTokens: 100000,
    maxOutputTokens: 4096,
    pricePerMTokens: { input: 1, output: 2, currency: "CNY" },
  });
  return {
    providers: [{ id: "fake", baseUrl: url, apiKeyEnv: "FAKE_API_KEY", streamOnly: true, useProxy: false }],
    models: [model("fake-l1", "L1", false), model("fake-l2", "L2", true), model("fake-l3", "L3", true)],
    roles: {
      L1: "fake-l1",
      L2: "fake-l2",
      L3: "fake-l3",
      classifier: "fake-l1",
      planner: "fake-l3",
      summarizer: "fake-l1",
      title: "fake-l1",
      judge: "fake-l3",
    },
  };
}

export const FAKE_SECRET = "fake-secret-key-1234567890";
