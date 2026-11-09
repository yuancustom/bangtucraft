import type { RunEventBody } from "@drawing-agent/shared";
import type { McpConfig } from "../agent/mcp.ts";
import type { SkillCatalog } from "../agent/skills.ts";
import type { ModelsFile } from "../models/schema.ts";

/** 网关传给用户 Worker 的初始化数据（经 IPC 传递，不写入 argv / env）。 */
export interface WorkerInit {
  type: "init";
  userId: string;
  userDir: string;
  rootDir: string;
  models: ModelsFile;
  secrets: Record<string, string>;
  skills: SkillCatalog;
  mcp: McpConfig;
  python: { uvExe: string; root: string; indexUrl: string; httpsProxy?: string };
  extraEnv: Record<string, string | undefined>;
  network: { httpsProxy?: string; noProxy?: string };
}

export type WorkerMethod =
  | "listThreads"
  | "createThread"
  | "renameThread"
  | "deleteThread"
  | "history"
  | "startRun"
  | "respondApproval"
  | "respondQuestion"
  | "decidePlan"
  | "abortRun"
  | "listSkills"
  | "traceList"
  | "trace"
  | "activeRuns";

export interface WorkerRequest {
  type: "request";
  id: number;
  method: WorkerMethod;
  params: unknown[];
}

export type WorkerMessage =
  | { type: "ready" }
  | { type: "response"; id: number; ok: true; result: unknown }
  | { type: "response"; id: number; ok: false; error: string }
  | { type: "event"; runId: string; body: RunEventBody };
