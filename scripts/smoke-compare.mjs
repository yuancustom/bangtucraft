// 对比流程冒烟：列原版会话 → 用评测用例建对比（两列）→ 等待结束 → 评审。会调用真实模型。
// 用法：node scripts/smoke-compare.mjs <caseId> [model1,model2]
const base = process.env.SMOKE_BASE ?? "http://127.0.0.1:8787";
const [, , caseId = "general-intro", models = "deepseek-v4-flash,gpt-6.1-sol"] = process.argv;
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
const orig = await call("GET", "/api/original/threads");
console.log("原版会话：", orig.available, orig.threads.map((t) => `${t.title}(${t.messageCount})`).join("；"));
if (orig.threads[0]) {
  const { turns } = await call("GET", `/api/original/threads/${orig.threads[0].id}`);
  for (const t of turns) console.log(`  第${t.index + 1}轮 工具${t.toolCalls.length}次 tokens ${t.inputTokens}/${t.outputTokens} 耗时${Math.round(t.durationMs / 1000)}s：${t.userText.slice(0, 40)}`);
}
const { compare } = await call("POST", "/api/compare", {
  caseId,
  permissionMode: "full-access",
  replicas: models.split(",").map((m) => ({ label: m, model: m })),
});
console.log("对比", compare.id);
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const { compare: c } = await call("GET", `/api/compare/${compare.id}`);
  const statuses = c.columns.map((col) => col.metrics.status);
  if (statuses.every((s) => ["completed", "failed", "cancelled"].includes(s))) {
    for (const col of c.columns) {
      const m = col.metrics;
      console.log(`[${col.label}] ${m.status} 模型=${m.models.join("/")} 工具=${m.toolCalls} tokens=${m.inputTokens}/${m.outputTokens} 成本=${m.costEstimate} 断言=${col.assertions.filter((a) => a.passed).length}/${col.assertions.length}`);
    }
    break;
  }
}
const { judge } = await call("POST", `/api/compare/${compare.id}/judge`, {});
console.log("评审", judge.modelId, JSON.stringify(judge.result).slice(0, 800));
