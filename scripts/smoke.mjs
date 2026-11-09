// 端到端冒烟（会调用真实模型，少量 token）。
// 用法：node scripts/smoke.mjs "<问题>" [模型ID|auto] [request|full-access]
const base = process.env.SMOKE_BASE ?? "http://127.0.0.1:8787";
const [, , prompt = "你好，用一句话介绍你自己", model = "auto", mode = "request"] = process.argv;
const user = { username: process.env.SMOKE_USER ?? "smoke", password: process.env.SMOKE_PASS ?? "smoke-password-1" };
let cookie = "";

async function call(method, path, body) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data.error ?? ""}`);
  return data;
}

try {
  await call("POST", "/api/auth/login", user);
} catch {
  await call("POST", "/api/auth/register", user);
}
const { session } = await call("POST", "/api/sessions", { title: "smoke" });
const { runId } = await call("POST", `/api/sessions/${session.id}/messages`, {
  text: prompt,
  model,
  permissionMode: mode,
  skills: process.env.SMOKE_SKILLS ? process.env.SMOKE_SKILLS.split(",") : undefined,
});
console.log("thread", session.id, "run", runId);

const res = await fetch(`${base}/api/runs/${runId}/events`, { headers: { cookie } });
const decoder = new TextDecoder();
let buffer = "";
let text = "";
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let i;
  while ((i = buffer.indexOf("\n\n")) >= 0) {
    const frame = buffer.slice(0, i);
    buffer = buffer.slice(i + 2);
    const data = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!data || !frame.includes("event: run")) continue;
    const e = JSON.parse(data.slice(5));
    if (e.type === "text") text += e.delta;
    else if (e.type === "reasoning") continue;
    else console.log(e.type, JSON.stringify(e).slice(0, 300));
    if (e.type === "approval" && process.env.SMOKE_APPROVE) {
      await call("POST", `/api/runs/${runId}/approval`, { toolCallId: e.toolCallId, approved: true });
    }
    if (e.type === "plan" && process.env.SMOKE_PLAN) {
      await call("POST", `/api/runs/${runId}/plan`, { action: process.env.SMOKE_PLAN });
    }
    if (e.type === "done") {
      console.log("---- 回答 ----\n" + text);
      process.exit(0);
    }
  }
}
