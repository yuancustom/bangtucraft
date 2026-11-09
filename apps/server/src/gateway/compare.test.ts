import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunTrace } from "@drawing-agent/shared";
import {
  CompareStore,
  buildJudgePrompt,
  checkAssertions,
  loadEvalCases,
  metricsFromOriginal,
  metricsFromTrace,
  parseJudge,
} from "./compare.ts";
import { OriginalImporter } from "./original.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-test-"));
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

/** 构造与原版结构一致的脱敏样例库（attributes 用 jsonb 存储，与原版相同）。 */
function sampleDb(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE mastra_threads (id TEXT, resourceId TEXT, title TEXT, metadata TEXT, createdAt TEXT, updatedAt TEXT);
    CREATE TABLE mastra_messages (id TEXT, thread_id TEXT, content TEXT, role TEXT, type TEXT, createdAt TEXT, resourceId TEXT);
    CREATE TABLE mastra_ai_spans (spanType TEXT, name TEXT, attributes BLOB, startedAt TEXT, endedAt TEXT, threadId TEXT);
  `);
  db.prepare("INSERT INTO mastra_threads VALUES ('th1','local-user','测试会话',NULL,'2026-11-01T00:00:00Z','2026-11-01T00:10:00Z')").run();
  const msg = db.prepare("INSERT INTO mastra_messages VALUES (?,?,?,?,?,?,?)");
  msg.run("m1", "th1", JSON.stringify({ format: 2, parts: [{ type: "text", text: "生成目录" }] }), "user", "v2", "2026-11-01T00:00:00.000Z", "local-user");
  msg.run(
    "m2",
    "th1",
    JSON.stringify({
      format: 2,
      parts: [
        { type: "tool-invocation", toolInvocation: { toolName: "present_files", args: { paths: ["目录.xlsx"] }, state: "result" } },
        { type: "text", text: "目录已生成。" },
      ],
    }),
    "assistant",
    "v2",
    "2026-11-01T00:01:00.000Z",
    "local-user",
  );
  msg.run("m3", "th1", JSON.stringify({ format: 2, parts: [{ type: "text", text: "第二问" }] }), "user", "v2", "2026-11-01T00:05:00.000Z", "local-user");
  const span = db.prepare("INSERT INTO mastra_ai_spans VALUES (?,?,jsonb(?),?,?,?)");
  span.run("model_generation", "llm: 'deepseek-flash'", JSON.stringify({ model: "deepseek-flash", usage: { inputTokens: 100, outputTokens: 20 } }), "2026-11-01T00:00:01Z", "2026-11-01T00:00:50Z", "th1");
  span.run("tool_call", "tool: 'skill'", JSON.stringify({ success: true }), "2026-11-01T00:00:02Z", "2026-11-01T00:00:03Z", "th1");
  span.run("mcp_tool_call", "mcp_tool: 'bangtu_create_dwg_task' on 'bangtu-mcp'", JSON.stringify({}), "2026-11-01T00:00:04Z", "2026-11-01T00:00:59Z", "th1");
  span.run("model_step", "step", JSON.stringify({}), "2026-11-01T00:00:01Z", "2026-11-01T00:00:10Z", "th1");
  db.close();
}

describe("OriginalImporter", () => {
  it("从快照读取会话、按用户消息切分轮次并归集用量与工具调用，不改动原库", () => {
    const source = path.join(dir, "bangtu.db");
    sampleDb(source);
    const before = fs.readFileSync(source);
    const importer = new OriginalImporter(source, path.join(dir, "snap"));
    expect(importer.listThreads()).toMatchObject([{ id: "th1", title: "测试会话", messageCount: 3 }]);
    const turns = importer.turns("th1");
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      userText: "生成目录",
      assistantText: "目录已生成。",
      models: ["deepseek-flash"],
      inputTokens: 100,
      outputTokens: 20,
      steps: 1,
      files: ["目录.xlsx"],
      toolCalls: [
        { toolName: "skill", isError: false },
        { toolName: "bangtu_create_dwg_task", isError: false },
      ],
    });
    expect(turns[0]!.durationMs).toBe(60_000);
    expect(fs.readFileSync(source).equals(before)).toBe(true);
  });

  it("未配置时报告不可用", () => {
    expect(new OriginalImporter(undefined, dir).available()).toBe(false);
  });
});

const trace: RunTrace = {
  runId: "r",
  threadId: "t",
  prompt: "p",
  status: "completed",
  models: ["deepseek-v4-flash"],
  escalations: [{ fromTier: "L1", toTier: "L2", reason: "x" }],
  toolCalls: [
    { toolName: "skill", isError: false },
    { toolName: "present_files", isError: true },
  ],
  steps: 3,
  inputTokens: 1000,
  outputTokens: 200,
  costEstimate: 0.01,
  durationMs: 5000,
  files: [{ path: "out/目录.xlsx", name: "目录.xlsx", size: 1, mediaType: "x" }],
  finalText: "已生成图纸目录，共 12 张。",
  createdAt: "",
};

describe("对比指标、断言与评审", () => {
  it("复刻版与原版映射到同一指标结构（快照）", () => {
    expect(metricsFromTrace(trace, "x")).toMatchInlineSnapshot(`
      {
        "costEstimate": 0.01,
        "durationMs": 5000,
        "escalations": 1,
        "files": [
          "out/目录.xlsx",
        ],
        "finalText": "已生成图纸目录，共 12 张。",
        "inputTokens": 1000,
        "models": [
          "deepseek-v4-flash",
        ],
        "outputTokens": 200,
        "status": "completed",
        "steps": 3,
        "toolCalls": 2,
        "toolErrors": 1,
        "toolSequence": [
          "skill",
          "present_files",
        ],
      }
    `);
    const original = metricsFromOriginal({
      index: 0,
      userText: "u",
      assistantText: "a",
      startedAt: "",
      endedAt: "",
      durationMs: 1,
      models: ["deepseek-flash"],
      inputTokens: 1,
      outputTokens: 2,
      steps: 1,
      toolCalls: [],
      files: [],
    });
    expect(original.costEstimate).toBeNull();
  });

  it("断言逐项判定", () => {
    const m = metricsFromTrace(trace, "x");
    const r = checkAssertions(
      [
        { type: "contains", value: "12 张" },
        { type: "not_contains", value: "抱歉" },
        { type: "tool_called", value: "skill" },
        { type: "file_delivered", value: "目录" },
        { type: "max_tool_calls", value: 1 },
      ],
      m,
    );
    expect(r.map((x) => x.passed)).toEqual([true, true, true, true, false]);
  });

  it("评审提示词包含各列与细则；解析评审 JSON", () => {
    const prompt = buildJudgePrompt("问题", "细则X", [{ label: "DeepSeek", metrics: metricsFromTrace(trace, "x") }]);
    expect(prompt).toContain("细则X");
    expect(prompt).toContain("### DeepSeek");
    expect(parseJudge('评审：{"scores":[{"label":"DeepSeek","score":8}],"summary":"好"}')).toEqual({
      scores: [{ label: "DeepSeek", score: 8, strengths: "", weaknesses: "" }],
      summary: "好",
    });
    expect(() => parseJudge("无")).toThrow();
  });

  it("评测用例从 YAML 加载并校验", () => {
    fs.writeFileSync(path.join(dir, "a.yaml"), "id: hello\ntitle: 打招呼\nprompt: 你好\nassertions:\n  - type: not_contains\n    value: 抱歉\n");
    fs.writeFileSync(path.join(dir, "b.yaml"), "id: Bad Id\ntitle: x\n");
    const { cases, errors } = loadEvalCases(dir);
    expect(cases.map((c) => c.id)).toEqual(["hello"]);
    expect(errors).toHaveLength(1);
  });

  it("对比记录按用户保存", () => {
    const store = new CompareStore((u) => path.join(dir, u));
    const r = store.create("u1", { title: "t", prompt: "p", rubric: "r", assertions: [], columns: [] });
    expect(store.get("u1", r.id).title).toBe("t");
    expect(() => store.get("u2", r.id)).toThrow();
    expect(() => store.get("u1", "../x")).toThrow();
  });
});
