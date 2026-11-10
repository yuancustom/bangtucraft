import type { FileCard, Plan, QuestionOption, RouteDecision, RunEvent, RunStatus } from "@drawing-agent/shared";

export type Block =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; toolCallId: string; toolName: string; args: unknown; result?: unknown; isError?: boolean }
  | { kind: "approval"; toolCallId: string; toolName: string; args: unknown; reason: string; resolved?: "approved" | "declined" }
  | {
      kind: "question";
      toolCallId: string;
      question: string;
      options?: QuestionOption[];
      allowMultiple: boolean;
      allowFreeText: boolean;
      resolved?: string;
    }
  | { kind: "plan"; plan: Plan; resolved?: string }
  | { kind: "files"; files: FileCard[] }
  | { kind: "note"; text: string; tone: "info" | "warn" | "error" };

export interface RunView {
  runId: string;
  threadId: string;
  prompt: string;
  startedAt: number;
  status: RunStatus;
  route?: RouteDecision;
  models: { modelId: string; tier: string; phase: string }[];
  blocks: Block[];
  usage?: { inputTokens: number; outputTokens: number; costEstimate: number; currency: string };
  finished: boolean;
  reconnecting?: boolean;
}

export function newRun(runId: string, threadId: string, prompt: string): RunView {
  return { runId, threadId, prompt, startedAt: Date.now(), status: "routing", models: [], blocks: [], finished: false };
}

const appendText = (blocks: Block[], kind: "text" | "reasoning", delta: string): Block[] => {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) return [...blocks.slice(0, -1), { ...last, text: last.text + delta }];
  return [...blocks, { kind, text: delta }];
};

export function applyEvent(run: RunView, e: RunEvent): RunView {
  switch (e.type) {
    case "status": {
      const next = { ...run, status: e.status };
      if (e.status === "running") {
        // 从等待中恢复：把未处理的卡片标记为已处理。
        next.blocks = run.blocks.map((b) =>
          (b.kind === "approval" || b.kind === "question") && !b.resolved ? { ...b, resolved: b.kind === "approval" ? "approved" : "已回答" } : b,
        ) as Block[];
      }
      return next;
    }
    case "route":
      return { ...run, route: e.decision };
    case "model":
      return { ...run, models: [...run.models, { modelId: e.modelId, tier: e.tier, phase: e.phase }] };
    case "escalate":
      return {
        ...run,
        models: [...run.models, { modelId: e.modelId, tier: e.toTier, phase: "execute" }],
        blocks: [...run.blocks, { kind: "note", tone: "warn", text: `升档 ${e.fromTier} → ${e.toTier}（${e.modelId}）：${e.reason}` }],
      };
    case "plan":
      return { ...run, blocks: [...run.blocks, { kind: "plan", plan: e.plan }] };
    case "text":
      return { ...run, blocks: appendText(run.blocks, "text", e.delta) };
    case "reasoning":
      return { ...run, blocks: appendText(run.blocks, "reasoning", e.delta) };
    case "tool-call":
      if (run.blocks.some((b) => b.kind === "tool" && b.toolCallId === e.toolCallId)) return run;
      return { ...run, blocks: [...run.blocks, { kind: "tool", toolCallId: e.toolCallId, toolName: e.toolName, args: e.args }] };
    case "tool-result": {
      let found = false;
      const blocks = run.blocks.map((b) => {
        if (b.kind === "tool" && b.toolCallId === e.toolCallId) {
          found = true;
          return { ...b, result: e.result, isError: e.isError };
        }
        return b;
      });
      if (!found) blocks.push({ kind: "tool", toolCallId: e.toolCallId, toolName: e.toolName, args: undefined, result: e.result, isError: e.isError });
      return { ...run, blocks };
    }
    case "approval":
      return { ...run, blocks: [...run.blocks, { kind: "approval", toolCallId: e.toolCallId, toolName: e.toolName, args: e.args, reason: e.reason }] };
    case "question":
      return {
        ...run,
        blocks: [
          ...run.blocks,
          { kind: "question", toolCallId: e.toolCallId, question: e.question, options: e.options, allowMultiple: e.allowMultiple, allowFreeText: e.allowFreeText },
        ],
      };
    case "files":
      return { ...run, blocks: [...run.blocks, { kind: "files", files: e.files }] };
    case "usage":
      return { ...run, usage: { inputTokens: e.inputTokens, outputTokens: e.outputTokens, costEstimate: e.costEstimate, currency: e.currency } };
    case "error":
      return { ...run, blocks: [...run.blocks, { kind: "note", tone: "error", text: e.message }] };
    case "done":
      return { ...run, finished: true };
  }
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  routing: "选择模型中",
  planning: "规划中",
  waiting_plan: "等待确认计划",
  running: "执行中",
  waiting_approval: "等待批准",
  waiting_input: "等待回答",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
};
