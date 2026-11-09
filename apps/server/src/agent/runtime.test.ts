import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEventBody } from "@drawing-agent/shared";
import { modelsFileSchema } from "../models/schema.ts";
import { ModelRegistry } from "../models/registry.ts";
import { Redactor } from "../redact.ts";
import { FAKE_SECRET, fakeModelsFile, startFakeOpenAI, type FakeReply } from "../test-utils/fake-openai.ts";
import { UserRuntime } from "./runtime.ts";

type Body = Record<string, unknown>;
const systemText = (body: Body) =>
  ((body.messages as { role: string; content: unknown }[]) ?? [])
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
const lastUser = (body: Body) => {
  const msgs = (body.messages as { role: string; content: unknown }[]) ?? [];
  const m = [...msgs].reverse().find((x) => x.role === "user");
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
};
const lastExec = (reqs: { body: Body }[]) => [...reqs].reverse().find((r) => systemText(r.body).includes("图纸助手") && !systemText(r.body).includes("会话标题"))!.body;
const hasToolResult = (body: Body, n = 1) => ((body.messages as { role: string }[]) ?? []).filter((m) => m.role === "tool").length >= n;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(executor: (body: Body) => FakeReply, opts: { classify?: string; plan?: string; title?: () => FakeReply | Promise<FakeReply> } = {}) {
  const fake = await startFakeOpenAI((body) => {
    const sys = systemText(body);
    if (sys.includes("任务难度分类器")) return { text: `{"tier":"${opts.classify ?? "simple"}"}` };
    if (sys.includes("任务规划者")) return { text: opts.plan ?? "{}" };
    if (sys.includes("会话标题") || lastUser(body).includes("会话标题")) return opts.title?.() ?? { text: "测试会话" };
    return executor(body);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-test-"));
  const registry = new ModelRegistry(modelsFileSchema.parse(fakeModelsFile(fake.url)), { FAKE_API_KEY: FAKE_SECRET });
  const events: RunEventBody[] = [];
  const waiters: { pred: (e: RunEventBody) => boolean; resolve: () => void }[] = [];
  const runtime = new UserRuntime({
    userId: "u1",
    userDir: dir,
    rootDir: dir,
    registry,
    redactor: new Redactor([FAKE_SECRET]),
    secrets: { FAKE_API_KEY: FAKE_SECRET },
    skills: { skills: [], problems: [], tiers: {} },
    mcp: { servers: {} },
    python: { uvExe: "uv", root: path.join(dir, "python"), indexUrl: "https://pypi.invalid/simple" },
    extraEnv: {},
    emit: (_runId, body) => {
      events.push(body);
      for (const w of [...waiters]) if (w.pred(body)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    },
  });
  await runtime.init();
  cleanups.push(async () => {
    await runtime.close();
    await fake.close();
    // Windows 下 LibSQL 可能仍持有文件句柄，清理失败不影响结果。
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 留给系统临时目录清理 */
    }
  });
  const waitFor = (pred: (e: RunEventBody) => boolean, timeoutMs = 20_000) =>
    events.some(pred)
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`等待事件超时；已有事件：${events.map((e) => e.type).join(",")}`)), timeoutMs);
          waiters.push({ pred, resolve: () => (clearTimeout(timer), resolve()) });
        });
  return { runtime, events, fake, waitFor, dir };
}

const done = (e: RunEventBody) => e.type === "done";

describe("UserRuntime（假模型）", () => {
  it("首轮成功问答概括命名，done前可读取，后续问答不重复命名", async () => {
    let names = 0;
    const { runtime, events, fake, waitFor } = await setup(() => ({ text: "可以先按平面轴网与剖面标高识读厂房。" }), { title: () => { names++; return { text: "“厂房图纸识读”" }; } });
    const thread = await runtime.createThread();
    await runtime.startRun(thread.id, { text: "厂房图纸怎么看", model: "fake-l2", permissionMode: "request" });
    await waitFor(done);
    expect((await runtime.listThreads())[0]?.title).toBe("厂房图纸识读");
    const request = fake.requests.find((r) => systemText(r.body).includes("首次问答"))!;
    expect(JSON.stringify(request.body.messages)).toContain("厂房图纸怎么看");
    expect(JSON.stringify(request.body.messages)).toContain("剖面标高");
    await runtime.startRun(thread.id, { text: "继续说", model: "fake-l2", permissionMode: "request" });
    await waitFor(() => events.filter(done).length === 2);
    expect(names).toBe(1);
    expect((await runtime.listThreads())[0]?.title).toBe("厂房图纸识读");
  });

  it.each(["我的厂房项目", "新会话"])("显式标题%s不被自动命名覆盖", async (title) => {
    let names = 0;
    const { runtime, waitFor } = await setup(() => ({ text: "收到" }), { title: () => { names++; return { text: "自动标题" }; } });
    const thread = await runtime.createThread(title);
    await runtime.startRun(thread.id, { text: "你好", model: "fake-l2", permissionMode: "request" });
    await waitFor(done);
    expect((await runtime.listThreads())[0]?.title).toBe(title);
    expect(names).toBe(0);
  });

  it("标题请求进行中手动改名，保留手动名称", async () => {
    let release!: () => void;
    let began!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { began = resolve; });
    const { runtime, waitFor } = await setup(() => ({ text: "你好" }), { title: async () => { began(); await gate; return { text: "迟到的自动标题" }; } });
    const thread = await runtime.createThread();
    await runtime.startRun(thread.id, { text: "你好", model: "fake-l2", permissionMode: "request" });
    await started;
    await runtime.renameThread(thread.id, "手动保留名称");
    release();
    await waitFor(done);
    expect((await runtime.listThreads())[0]?.title).toBe("手动保留名称");
  });

  it("命名接口失败不影响已成功的问答，并回退短主题", async () => {
    const { runtime, events, waitFor } = await setup(() => ({ text: "先核对配电柜的编号。" }), { title: () => ({ status: 503, errorBody: FAKE_SECRET }) });
    const thread = await runtime.createThread();
    await runtime.startRun(thread.id, { text: "配电柜编号核对", model: "fake-l2", permissionMode: "request" });
    await waitFor(done);
    expect((await runtime.listThreads())[0]?.title).toBe("配电柜编号核对");
    expect(events.at(-2)).toMatchObject({ type: "status", status: "completed" });
    expect(JSON.stringify(events)).not.toContain(FAKE_SECRET);
  });

  it("简单问题：L1 分类后由 L1 回答，历史与追踪落库", async () => {
    const { runtime, events, fake, waitFor } = await setup(() => ({ text: "你好，我是图纸助手。", reasoning: "先打招呼" }));
    const thread = await runtime.createThread();
    await runtime.startRun(thread.id, { text: "你好", model: "auto", permissionMode: "request" });
    await waitFor(done);
    const route = events.find((e) => e.type === "route");
    expect(route).toMatchObject({ decision: { modelId: "fake-l1", complexity: "simple" } });
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("你好，我是图纸助手。");
    expect(events.some((e) => e.type === "reasoning")).toBe(true);
    expect(events.at(-2)).toMatchObject({ type: "status", status: "completed" });
    const execReq = fake.requests.find((r) => systemText(r.body).includes("图纸助手"));
    expect(execReq?.body.model).toBe("fake-l1");
    const history = await runtime.history(thread.id);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    const [trace] = await runtime.traceList(thread.id);
    expect(trace).toMatchObject({ status: "completed", models: ["fake-l1"], steps: 1 });
    expect(trace!.inputTokens).toBeGreaterThan(0);
  });

  it("模型密钥不会被写进会话库（Observational Memory 配置等）", async () => {
    const { runtime, waitFor, dir } = await setup(() => ({ text: "好" }));
    const thread = await runtime.createThread();
    await runtime.startRun(thread.id, { text: "你好", model: "fake-l2", permissionMode: "request" });
    await waitFor(done);
    const { createClient } = await import("@libsql/client");
    const db = createClient({ url: `file:${path.join(dir, "agent.db")}` });
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table'");
    for (const row of tables.rows) {
      const name = String(row.name);
      const cols = await db.execute(`PRAGMA table_info("${name}")`);
      for (const c of cols.rows) {
        const hit = await db.execute({
          sql: `SELECT COUNT(*) AS n FROM "${name}" WHERE instr(CAST("${String(c.name)}" AS TEXT), ?) > 0`,
          args: [FAKE_SECRET],
        });
        expect(Number(hit.rows[0]!.n), `${name}.${String(c.name)}`).toBe(0);
      }
    }
    db.close();
  });

  it("请求批准模式下命令需批准，批准后执行并继续", async () => {
    const { runtime, events, waitFor } = await setup((body) =>
      hasToolResult(body)
        ? { text: "命令输出了 hello-approve。" }
        : { toolCalls: [{ name: "local_command_execute", args: { command: "Write-Output hello-approve" } }] },
    );
    const thread = await runtime.createThread();
    const runId = await runtime.startRun(thread.id, { text: "运行命令", model: "fake-l2", permissionMode: "request" });
    await waitFor((e) => e.type === "status" && e.status === "waiting_approval");
    const approval = events.find((e) => e.type === "approval") as Extract<RunEventBody, { type: "approval" }>;
    expect(approval.toolName).toBe("local_command_execute");
    await runtime.respondApproval(runId, approval.toolCallId, true);
    await waitFor(done);
    if (process.env.DEBUG_EVENTS) console.log(JSON.stringify(events, null, 1));
    const result = events.find((e) => e.type === "tool-result") as Extract<RunEventBody, { type: "tool-result" }>;
    expect((result.result as { stdout: string }).stdout).toContain("hello-approve");
    expect(events.at(-2)).toMatchObject({ type: "status", status: "completed" });
  });

  it("拒绝批准后命令不执行，模型收到拒绝说明", async () => {
    const { runtime, events, fake, waitFor } = await setup((body) =>
      hasToolResult(body) ? { text: "好的，不执行。" } : { toolCalls: [{ name: "local_command_execute", args: { command: "Write-Output nope" } }] },
    );
    const thread = await runtime.createThread();
    const runId = await runtime.startRun(thread.id, { text: "运行命令", model: "fake-l2", permissionMode: "request" });
    await waitFor((e) => e.type === "approval");
    const approval = events.find((e) => e.type === "approval") as Extract<RunEventBody, { type: "approval" }>;
    await runtime.respondApproval(runId, approval.toolCallId, false, "不要运行");
    await waitFor(done);
    const last = lastExec(fake.requests);
    expect(JSON.stringify(last.messages)).toContain("不要运行");
    expect(JSON.stringify(events)).not.toContain('"stdout":"nope');
  });

  it("ask_user 挂起提问，回答后继续", async () => {
    const { runtime, events, fake, waitFor } = await setup((body) =>
      hasToolResult(body)
        ? { text: "收到，你选了方案B。" }
        : { toolCalls: [{ name: "ask_user", args: { question: "选哪个？", options: [{ id: "a", label: "方案A" }, { id: "b", label: "方案B" }] } }] },
    );
    const thread = await runtime.createThread();
    const runId = await runtime.startRun(thread.id, { text: "帮我选", model: "fake-l2", permissionMode: "request" });
    await waitFor((e) => e.type === "question");
    const q = events.find((e) => e.type === "question") as Extract<RunEventBody, { type: "question" }>;
    expect(q.options?.map((o) => o.id)).toEqual(["a", "b"]);
    await runtime.respondQuestion(runId, q.toolCallId, { selectedIds: ["b"] });
    await waitFor(done);
    expect(JSON.stringify(lastExec(fake.requests).messages)).toContain('\\"b\\"');
  });

  it("同一工具连续失败两次后升档到更强模型", async () => {
    let calls = 0;
    const { runtime, events, fake, waitFor } = await setup(() => {
      calls++;
      if (calls <= 2) return { toolCalls: [{ name: "present_files", args: { paths: [`missing-${calls}.txt`] } }] };
      return { text: "文件不存在，无法交付。" };
    });
    const thread = await runtime.createThread();
    await runtime.startRun(thread.id, { text: "交付文件", model: "fake-l1", permissionMode: "full-access" });
    await waitFor(done);
    const esc = events.find((e) => e.type === "escalate");
    expect(esc).toMatchObject({ fromTier: "L1", toTier: "L2", modelId: "fake-l2" });
    const execModels = fake.requests.filter((r) => systemText(r.body).includes("图纸助手")).map((r) => r.body.model);
    expect(execModels).toEqual(["fake-l1", "fake-l1", "fake-l2"]);
  });

  it("complex 任务先出计划，确认后由计划指定的档位执行", async () => {
    const plan = JSON.stringify({ goal: "写报告", steps: [{ title: "写文件", detail: "生成 a.md" }], deliverables: ["a.md"], executorTier: "L1" });
    const { runtime, events, fake, waitFor } = await setup(() => ({ text: "按计划完成。" }), { classify: "complex", plan });
    const thread = await runtime.createThread();
    const runId = await runtime.startRun(thread.id, { text: "做个复杂的事", model: "auto", permissionMode: "full-access" });
    await waitFor((e) => e.type === "status" && e.status === "waiting_plan");
    expect(events.find((e) => e.type === "plan")).toMatchObject({ plan: { goal: "写报告", executorTier: "L1" } });
    expect(fake.requests.some((r) => r.body.model === "fake-l3" && systemText(r.body).includes("任务规划者"))).toBe(true);
    await runtime.decidePlan(runId, { action: "approve" });
    await waitFor(done);
    const exec = fake.requests.find((r) => systemText(r.body).includes("图纸助手"))!;
    expect(exec.body.model).toBe("fake-l1");
    expect(JSON.stringify(exec.body.messages)).toContain("已确认的执行计划");
    const trace = await runtime.trace(runId);
    expect(trace?.models).toEqual(expect.arrayContaining(["fake-l1", "fake-l3"]));
  });

  it("拒绝计划时本轮取消", async () => {
    const plan = JSON.stringify({ goal: "g", steps: [{ title: "s" }], deliverables: [], executorTier: "L2" });
    const { runtime, events, waitFor } = await setup(() => ({ text: "x" }), { classify: "complex", plan });
    const thread = await runtime.createThread();
    const runId = await runtime.startRun(thread.id, { text: "复杂", model: "auto", permissionMode: "request" });
    await waitFor((e) => e.type === "status" && e.status === "waiting_plan");
    await runtime.decidePlan(runId, { action: "reject" });
    await waitFor(done);
    expect(events.some((e) => e.type === "status" && e.status === "cancelled")).toBe(true);
  });

  it("中途停止：慢输出被中止，本轮标记为取消", async () => {
    const { runtime, events, waitFor } = await setup(() => ({ text: "很长很长的回答".repeat(30), delayMs: 50 }));
    const thread = await runtime.createThread();
    const runId = await runtime.startRun(thread.id, { text: "说很多", model: "fake-l2", permissionMode: "request" });
    await waitFor((e) => e.type === "text");
    runtime.abortRun(runId);
    await waitFor(done);
    expect(events.some((e) => e.type === "status" && e.status === "cancelled")).toBe(true);
  });

  it("模型报错时本轮失败且错误信息脱敏", async () => {
    const { runtime, events, waitFor } = await setup(() => ({ status: 500, errorBody: `boom ${FAKE_SECRET}` }));
    const thread = await runtime.createThread();
    await runtime.startRun(thread.id, { text: "hi", model: "fake-l2", permissionMode: "request" });
    await waitFor(done, 60_000);
    expect(events.some((e) => e.type === "status" && e.status === "failed")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(FAKE_SECRET);
  }, 90_000);
});
