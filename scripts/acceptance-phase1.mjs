// Independent acceptance probes. Local fixtures only; no real model/MCP calls.
// Run: corepack pnpm -C apps/server exec tsx ../../scripts/acceptance-phase1.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserRuntime } from "../apps/server/src/agent/runtime.ts";
import { Redactor } from "../apps/server/src/redact.ts";
import { ModelRegistry } from "../apps/server/src/models/registry.ts";
import { modelsFileSchema } from "../apps/server/src/models/schema.ts";
import { FAKE_SECRET, fakeModelsFile, startFakeOpenAI } from "../apps/server/src/test-utils/fake-openai.ts";
import { AuthStore } from "../apps/server/src/gateway/auth.ts";
import { RunHub } from "../apps/server/src/gateway/run-hub.ts";
import { saveUpload } from "../apps/server/src/gateway/files.ts";
import { commandEnvironment, runPowerShell } from "../apps/server/src/agent/tools/local-command.ts";

const auditRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bangtu-acceptance-"));
const results = [];
const sys = (b) => (b.messages ?? []).filter(m => m.role === "system").map(m => JSON.stringify(m.content)).join("\n");
const textOf = (b) => [...(b.messages ?? [])].reverse().find(m => m.role === "user")?.content;
const toolsOf = (b) => (b.messages ?? []).filter(m => m.role === "tool");
const plan = JSON.stringify({ goal: "acceptance", steps: [{ title: "inspect" }], deliverables: [], executorTier: "L1" });
const delay = ms => new Promise(r => setTimeout(r, ms));

async function fixture(executor, options = {}) {
  const fake = await startFakeOpenAI(b => {
    if (sys(b).includes("任务难度分类器")) return { text: JSON.stringify({ tier: options.complex ? "complex" : "simple" }) };
    if (sys(b).includes("任务规划者")) return { text: options.plan ?? plan };
    if (sys(b).includes("会话标题") || JSON.stringify(textOf(b)).includes("会话标题")) return { text: "验收" };
    return executor(b);
  });
  const dir = fs.mkdtempSync(path.join(auditRoot, "runtime-"));
  const events = [];
  const runtime = new UserRuntime({
    userId: "acceptance", userDir: dir, rootDir: dir,
    registry: new ModelRegistry(modelsFileSchema.parse(fakeModelsFile(fake.url)), { FAKE_API_KEY: FAKE_SECRET }),
    redactor: new Redactor([FAKE_SECRET]), secrets: { FAKE_API_KEY: FAKE_SECRET },
    skills: { skills: [], problems: [], tiers: {} }, mcp: { servers: {} },
    python: { uvExe: "uv", root: path.join(dir, "python"), indexUrl: "https://pypi.invalid/simple" },
    extraEnv: {}, emit: (runId, body) => events.push({ runId, ...body }), maxSteps: 8,
  });
  await runtime.init();
  const wait = async (predicate, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`event timeout: ${events.map(e => e.type).join(",")}`);
      await delay(20);
    }
    await delay(30);
  };
  return { runtime, events, fake, dir, wait, close: async () => { await runtime.close(); await fake.close(); } };
}

async function probe(name, run) {
  try { const result = await run(); results.push({ name, ...result }); }
  catch (e) { results.push({ name, pass: false, harnessError: String(e) }); }
  console.log(JSON.stringify(results.at(-1)));
}

await probe("streamed-secret-redaction", async () => {
  const f = await fixture(() => ({ text: FAKE_SECRET, reasoning: FAKE_SECRET }));
  try {
    const t = await f.runtime.createThread();
    await f.runtime.startRun(t.id, { text: "echo-test", model: "fake-l2", permissionMode: "request" });
    await f.wait(() => f.events.some(e => e.type === "done"));
    const text = f.events.filter(e => e.type === "text").map(e => e.delta).join("");
    const reasoning = f.events.filter(e => e.type === "reasoning").map(e => e.delta).join("");
    const history = JSON.stringify(await f.runtime.history(t.id));
    return { pass: !text.includes(FAKE_SECRET) && !history.includes(FAKE_SECRET), textLeaks: text.includes(FAKE_SECRET), reasoningLeaks: reasoning.includes(FAKE_SECRET), historyLeaks: history.includes(FAKE_SECRET) };
  } finally { await f.close(); }
});

await probe("malformed-plan-must-not-execute-without-confirmation", async () => {
  const f = await fixture(b => toolsOf(b).length ? { text: "done" } : { toolCalls: [{ name: "local_command_execute", args: { command: "Write-Output acceptance-only" } }] }, { complex: true, plan: "{}" });
  try {
    const t = await f.runtime.createThread();
    await f.runtime.startRun(t.id, { text: "complex", model: "auto", permissionMode: "request" });
    await f.wait(() => f.events.some(e => e.type === "approval" || e.type === "done" || e.type === "plan"));
    const executions = f.events.filter(e => e.type === "model" && e.phase === "execute").length;
    const approvals = f.events.filter(e => e.type === "plan").length;
    const r = { pass: executions === 0, executionStarted: executions > 0, planCards: approvals };
    const active = f.runtime.activeRuns()[0];
    if (active) { f.runtime.abortRun(active.runId); await f.wait(() => f.events.some(e => e.type === "done")); }
    return r;
  } finally { await f.close(); }
});

await probe("parallel-tool-approvals-remain-actionable", async () => {
  const f = await fixture(b => toolsOf(b).length ? { text: "done" } : { toolCalls: [
    { name: "local_command_execute", args: { command: "Write-Output first" } },
    { name: "local_command_execute", args: { command: "Write-Output second" } },
  ] });
  try {
    const t = await f.runtime.createThread();
    const run = await f.runtime.startRun(t.id, { text: "parallel", model: "fake-l2", permissionMode: "request" });
    await f.wait(() => f.events.some(e => e.type === "status" && e.status === "waiting_approval"));
    const cards = f.events.filter(e => e.type === "approval");
    let rejectedFirst = false;
    try { await f.runtime.respondApproval(run, cards[0].toolCallId, false); }
    catch { rejectedFirst = true; }
    f.runtime.abortRun(run);
    await f.wait(() => f.events.some(e => e.type === "done"));
    return { pass: !rejectedFirst, approvalCards: cards.length, firstCardRejectedAsInvalid: rejectedFirst };
  } finally { await f.close(); }
});

await probe("images-remain-on-vision-model-after-plan", async () => {
  const f = await fixture(() => ({ text: "image-answer" }), { complex: true });
  try {
    fs.writeFileSync(path.join(f.runtime.workspaceRoot, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64"));
    const t = await f.runtime.createThread();
    const run = await f.runtime.startRun(t.id, { text: "complex image", model: "auto", permissionMode: "request", images: ["pixel.png"] });
    await f.wait(() => f.events.some(e => e.type === "plan"));
    const planningBody = f.fake.requests.find(r => sys(r.body).includes("任务规划者"))?.body;
    await f.runtime.decidePlan(run, { action: "approve" });
    await f.wait(() => f.events.some(e => e.type === "done"));
    const executionModel = f.events.find(e => e.type === "model" && e.phase === "execute")?.modelId;
    return { pass: executionModel !== "fake-l1", executionModel, plannerReceivedImage: JSON.stringify(planningBody).includes("image_url"), status: f.events.filter(e => e.type === "status").at(-1)?.status };
  } finally { await f.close(); }
});

await probe("native-workspace-tool-blocks-junction-escape", async () => {
  const outside = path.join(auditRoot, "outside-native"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "marker.txt"), "OUTSIDE-MARKER");
  const f = await fixture(b => toolsOf(b).length ? { text: "finished" } : { toolCalls: [{ name: "mastra_workspace_read_file", args: { path: "link/marker.txt" } }] });
  try {
    fs.symlinkSync(outside, path.join(f.runtime.workspaceRoot, "link"), "junction");
    const t = await f.runtime.createThread();
    await f.runtime.startRun(t.id, { text: "read file", model: "fake-l2", permissionMode: "request" });
    await f.wait(() => f.events.some(e => e.type === "done"));
    const outputs = JSON.stringify(f.events.filter(e => e.type === "tool-result"));
    return { pass: !outputs.includes("OUTSIDE-MARKER"), outsideContentRead: outputs.includes("OUTSIDE-MARKER"), errorReported: f.events.some(e => e.type === "tool-result" && e.isError) };
  } finally { await f.close(); }
});

await probe("upload-blocks-junction-escape", async () => {
  const data = path.join(auditRoot, "upload-data");
  const victim = path.join(data, "users", "bob", "workspace");
  const alice = path.join(data, "users", "alice", "workspace");
  fs.mkdirSync(victim, { recursive: true }); fs.mkdirSync(alice, { recursive: true });
  fs.symlinkSync(victim, path.join(alice, "uploads"), "junction");
  let rejected = false;
  try { await saveUpload(data, "alice", new File(["TEST-MARKER"], "probe.txt")); } catch { rejected = true; }
  const wroteOtherUser = fs.existsSync(path.join(victim, "probe.txt"));
  return { pass: rejected && !wroteOtherUser, rejected, wroteOtherUser };
});

await probe("concurrent-register-respects-three-user-limit", async () => {
  const store = new AuthStore(path.join(auditRoot, "auth.db"));
  try {
    await store.register("user00", "acceptance-password");
    await store.register("user01", "acceptance-password");
    const requests = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => store.register(`race${i}`, "acceptance-password")));
    const userCount = await store.userCount();
    return { pass: userCount <= 3, userCount, concurrentSucceeded: requests.filter(x => x.status === "fulfilled").length };
  } finally { store.close(); }
});

await probe("long-stream-event-sequence-is-monotonic", async () => {
  const hub = new RunHub(); hub.register("run", "user", "thread");
  let prev = 0; let duplicateSequence = false; let emitted = 0;
  hub.subscribe("run", 0, e => { emitted++; if (e.seq <= prev) duplicateSequence = true; prev = e.seq; });
  for (let i = 0; i < 20005; i++) hub.push("user", "run", { type: "text", delta: "a" });
  hub.push("user", "run", { type: "status", status: "completed" });
  hub.push("user", "run", { type: "done", finishReason: "stop" });
  return { pass: !duplicateSequence, duplicateSequence, emitted, cached: hub.get("run").events.length };
});

await probe("powershell-cmdlet-error-is-failure", async () => {
  const r = await runPowerShell("Get-Content -LiteralPath './nonexistent-acceptance-file.txt'", { cwd: auditRoot, env: commandEnvironment(), timeoutMs: 5000 });
  return { pass: !r.success, success: r.success, exitCode: r.exitCode, stderrPresent: Boolean(r.stderr.trim()) };
});

await probe("same-user-concurrent-runs-do-not-mix", async () => {
  const f = await fixture(b => ({ text: String(textOf(b)), delayMs: 5 }));
  try {
    const a = await f.runtime.createThread(); const b = await f.runtime.createThread();
    const ar = await f.runtime.startRun(a.id, { text: "ALPHA-ONLY", model: "fake-l2", permissionMode: "request" });
    const br = await f.runtime.startRun(b.id, { text: "BRAVO-ONLY", model: "fake-l2", permissionMode: "request" });
    await f.wait(() => f.events.filter(e => e.type === "done").length === 2);
    const output = id => f.events.filter(e => e.runId === id && e.type === "text").map(e => e.delta).join("");
    return { pass: output(ar) === "ALPHA-ONLY" && output(br) === "BRAVO-ONLY", alphaIsolated: output(ar) === "ALPHA-ONLY", bravoIsolated: output(br) === "BRAVO-ONLY" };
  } finally { await f.close(); }
});

const out = fileURLToPath(new URL("../docs/eval-reports/2026-11-07-phase1-probes.json", import.meta.url));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ date: "2026-11-07", fixtureRoot: auditRoot, realExternalCalls: 0, results }, null, 2));
console.log(JSON.stringify({ report: out, passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length }));
process.exitCode = results.some(r => !r.pass) ? 1 : 0;
