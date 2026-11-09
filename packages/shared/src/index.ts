// 前后端共用的协议类型。

export interface HealthResponse {
  status: "ok";
}

export type Tier = "L1" | "L2" | "L3";
export type PermissionMode = "request" | "full-access";

export interface ModelInfo {
  id: string;
  name: string;
  tier: Tier;
  provider: string;
  capabilities: { tools: boolean; images: boolean; reasoning: boolean };
}

export interface RouteDecision {
  tier: Tier;
  modelId: string;
  /** simple / standard / complex；complex 会先规划。 */
  complexity: "simple" | "standard" | "complex";
  plan: boolean;
  reasons: string[];
}

export interface PlanStep {
  title: string;
  detail: string;
  tools?: string[];
  skills?: string[];
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  deliverables: string[];
  executorTier: "L1" | "L2";
  risks?: string[];
}

export interface FileCard {
  path: string;
  name: string;
  size: number;
  mediaType: string;
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export type RunStatus =
  | "routing"
  | "planning"
  | "waiting_plan"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

/** 一轮运行推送给前端的事件。所有事件都带 runId 与递增 seq。 */
export type RunEventBody =
  | { type: "status"; status: RunStatus; message?: string }
  | { type: "route"; decision: RouteDecision }
  | { type: "escalate"; fromTier: Tier; toTier: Tier; modelId: string; reason: string }
  | { type: "model"; modelId: string; tier: Tier; phase: "plan" | "execute" }
  | { type: "plan"; plan: Plan }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "approval"; toolCallId: string; toolName: string; args: unknown; reason: string }
  | {
      type: "question";
      toolCallId: string;
      question: string;
      options?: QuestionOption[];
      allowMultiple: boolean;
      allowFreeText: boolean;
    }
  | { type: "files"; files: FileCard[] }
  | { type: "usage"; inputTokens: number; outputTokens: number; costEstimate: number; currency: string }
  | { type: "done"; finishReason: string }
  | { type: "error"; message: string };

export type RunEvent = RunEventBody & { runId: string; seq: number; at: number };

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** 历史消息中的展示片段。 */
export type HistoryPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; toolCallId: string; toolName: string; args: unknown; result?: unknown; isError?: boolean }
  | { type: "files"; files: FileCard[] };

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  createdAt: string;
  parts: HistoryPart[];
}

export interface SkillInfo {
  name: string;
  description: string;
  source: "own" | "local" | "vendor-bangtu";
  tier?: Tier;
}

export interface SendMessageRequest {
  text: string;
  /** "auto" 或具体模型 ID。 */
  model: string;
  permissionMode: PermissionMode;
  skills?: string[];
  /** 已上传到工作空间的图片（相对路径），用于看图任务。 */
  images?: string[];
}

export interface RunTrace {
  runId: string;
  threadId: string;
  prompt: string;
  status: RunStatus;
  route?: RouteDecision;
  plan?: Plan;
  models: string[];
  escalations: { fromTier: Tier; toTier: Tier; reason: string }[];
  toolCalls: { toolName: string; isError: boolean }[];
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costEstimate: number;
  durationMs: number;
  files: FileCard[];
  finalText: string;
  createdAt: string;
  error?: string;
}
