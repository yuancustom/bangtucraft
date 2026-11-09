import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { RunTrace } from "@drawing-agent/shared";
import type { OriginalTurn } from "./original.ts";

export const assertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("contains"), value: z.string().min(1) }),
  z.object({ type: z.literal("not_contains"), value: z.string().min(1) }),
  z.object({ type: z.literal("tool_called"), value: z.string().min(1) }),
  z.object({ type: z.literal("file_delivered"), value: z.string().min(1).describe("文件名中包含的字符串") }),
  z.object({ type: z.literal("max_tool_calls"), value: z.number().int().min(0) }),
]);
export type Assertion = z.infer<typeof assertionSchema>;

export const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  prompt: z.string().min(1),
  rubric: z.string().optional(),
  assertions: z.array(assertionSchema).default([]),
});
export type EvalCase = z.infer<typeof evalCaseSchema>;

export function loadEvalCases(dir: string): { cases: EvalCase[]; errors: string[] } {
  const cases: EvalCase[] = [];
  const errors: string[] = [];
  if (!fs.existsSync(dir)) return { cases, errors };
  for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    try {
      const parsed = evalCaseSchema.safeParse(parseYaml(fs.readFileSync(path.join(dir, file), "utf8")));
      if (parsed.success) cases.push(parsed.data);
      else errors.push(`${file}: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    } catch {
      errors.push(`${file}: 不是合法 YAML`);
    }
  }
  return { cases, errors };
}

/** 一列对比结果的统一指标，原版导入与复刻版运行都映射到这里。 */
export interface ColumnMetrics {
  status: string;
  models: string[];
  escalations: number;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  toolSequence: string[];
  inputTokens: number;
  outputTokens: number;
  costEstimate: number | null;
  durationMs: number;
  files: string[];
  finalText: string;
}

export function metricsFromTrace(trace: RunTrace | undefined, status: string): ColumnMetrics {
  return {
    status: trace?.status ?? status,
    models: trace?.models ?? [],
    escalations: trace?.escalations.length ?? 0,
    steps: trace?.steps ?? 0,
    toolCalls: trace?.toolCalls.length ?? 0,
    toolErrors: trace?.toolCalls.filter((t) => t.isError).length ?? 0,
    toolSequence: trace?.toolCalls.map((t) => t.toolName) ?? [],
    inputTokens: trace?.inputTokens ?? 0,
    outputTokens: trace?.outputTokens ?? 0,
    costEstimate: trace?.costEstimate ?? 0,
    durationMs: trace?.durationMs ?? 0,
    files: trace?.files.map((f) => f.path) ?? [],
    finalText: trace?.finalText ?? "",
  };
}

export function metricsFromOriginal(turn: OriginalTurn): ColumnMetrics {
  return {
    status: "completed",
    models: turn.models,
    escalations: 0,
    steps: turn.steps,
    toolCalls: turn.toolCalls.length,
    toolErrors: turn.toolCalls.filter((t) => t.isError).length,
    toolSequence: turn.toolCalls.map((t) => t.toolName),
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    // 原版模型单价未知，不估算。
    costEstimate: null,
    durationMs: turn.durationMs,
    files: turn.files,
    finalText: turn.assistantText,
  };
}

export function checkAssertions(assertions: Assertion[], m: ColumnMetrics): { assertion: Assertion; passed: boolean }[] {
  return assertions.map((a) => {
    switch (a.type) {
      case "contains":
        return { assertion: a, passed: m.finalText.includes(a.value) };
      case "not_contains":
        return { assertion: a, passed: !m.finalText.includes(a.value) };
      case "tool_called":
        return { assertion: a, passed: m.toolSequence.includes(a.value) };
      case "file_delivered":
        return { assertion: a, passed: m.files.some((f) => f.includes(a.value)) };
      case "max_tool_calls":
        return { assertion: a, passed: m.toolCalls <= a.value };
    }
  });
}

export const DEFAULT_RUBRIC = `按以下维度给每个回答打 1–10 分：
1. 正确性：结论与事实一致，没有编造工具结果、文件或数据。
2. 完整性：覆盖了用户问题的全部要求。
3. 过程合理性：工具和技能使用得当，没有无效重复，失败时如实说明。
4. 交付质量：成果文件真实交付、表达清晰。`;

export const judgeResultSchema = z.object({
  scores: z.array(z.object({ label: z.string(), score: z.number().min(0).max(10), strengths: z.string().default(""), weaknesses: z.string().default("") })),
  summary: z.string().default(""),
});
export type JudgeResult = z.infer<typeof judgeResultSchema>;

export function buildJudgePrompt(prompt: string, rubric: string, columns: { label: string; metrics: ColumnMetrics }[]): string {
  const blocks = columns.map(
    (c) =>
      `### ${c.label}\n状态：${c.metrics.status}；工具调用 ${c.metrics.toolCalls} 次（失败 ${c.metrics.toolErrors}）：${c.metrics.toolSequence.slice(0, 60).join(" → ") || "无"}\n交付文件：${c.metrics.files.join("、") || "无"}\n最终回答：\n${c.metrics.finalText.slice(0, 6000) || "（空）"}`,
  );
  return `你是严格、公正的评审。下面是同一个用户问题的多个回答（来自不同的智能体配置），请按评分细则逐个打分。不要因为回答更长就给高分；只依据给出的内容判断，无法核实的内容视为未证实。

用户问题：
${prompt}

评分细则：
${rubric}

${blocks.join("\n\n")}

只输出 JSON：{"scores":[{"label":"...","score":0-10,"strengths":"...","weaknesses":"..."}],"summary":"总体比较结论"}`;
}

export function parseJudge(raw: string): JudgeResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("评审输出中没有 JSON");
  return judgeResultSchema.parse(JSON.parse(raw.slice(start, end + 1)));
}

// ---------------- 对比记录 ----------------

export type CompareColumn =
  | { kind: "replica"; label: string; model: string; threadId: string; runId: string }
  | { kind: "original"; label: string; originalThreadId: string; turnIndex: number; snapshot: ColumnMetrics; userText: string };

export interface CompareRecord {
  id: string;
  title: string;
  prompt: string;
  caseId?: string;
  rubric: string;
  assertions: Assertion[];
  createdAt: string;
  columns: CompareColumn[];
  judge?: { modelId: string; result: JudgeResult; at: string };
}

export class CompareStore {
  constructor(private readonly dir: (userId: string) => string) {}

  private file(userId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("对比记录不存在");
    return path.join(this.dir(userId), `${id}.json`);
  }

  create(userId: string, record: Omit<CompareRecord, "id" | "createdAt">): CompareRecord {
    const full: CompareRecord = { ...record, id: randomUUID(), createdAt: new Date().toISOString() };
    fs.mkdirSync(this.dir(userId), { recursive: true });
    fs.writeFileSync(this.file(userId, full.id), JSON.stringify(full, null, 2));
    return full;
  }

  get(userId: string, id: string): CompareRecord {
    const f = this.file(userId, id);
    if (!fs.existsSync(f)) throw new Error("对比记录不存在");
    return JSON.parse(fs.readFileSync(f, "utf8")) as CompareRecord;
  }

  save(userId: string, record: CompareRecord) {
    fs.writeFileSync(this.file(userId, record.id), JSON.stringify(record, null, 2));
  }

  list(userId: string): CompareRecord[] {
    const dir = this.dir(userId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as CompareRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
