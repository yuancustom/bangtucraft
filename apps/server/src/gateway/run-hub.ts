import type { RunEvent, RunEventBody } from "@drawing-agent/shared";

interface RunEntry {
  runId: string;
  userId: string;
  threadId: string;
  events: RunEvent[];
  listeners: Set<(e: RunEvent) => void>;
  finished: boolean;
  /** 收到 startRun 响应之前到达的事件也要保留。 */
  createdAt: number;
}

const MAX_EVENTS = 20_000;
const KEEP_FINISHED_MS = 10 * 60_000;

/** 网关侧的运行事件中心：按 runId 缓存事件，支持 SSE 断线续传，迟到 / 未登记的事件按 runId 丢弃。 */
export class RunHub {
  private runs = new Map<string, RunEntry>();

  register(runId: string, userId: string, threadId: string) {
    if (this.runs.has(runId)) throw new Error("runId 重复");
    this.runs.set(runId, { runId, userId, threadId, events: [], listeners: new Set(), finished: false, createdAt: Date.now() });
  }

  get(runId: string) {
    return this.runs.get(runId);
  }

  /** 来自 Worker 的事件。userId 必须与登记一致，否则丢弃（防止串号）。 */
  push(userId: string, runId: string, body: RunEventBody): boolean {
    const run = this.runs.get(runId);
    if (!run || run.userId !== userId || run.finished) return false;
    const event: RunEvent = { ...body, runId, seq: run.events.length + 1, at: Date.now() } as RunEvent;
    if (run.events.length < MAX_EVENTS || body.type !== "text") run.events.push(event);
    for (const l of run.listeners) l(event);
    if (body.type === "done") {
      run.finished = true;
      setTimeout(() => this.runs.delete(runId), KEEP_FINISHED_MS).unref?.();
    }
    return true;
  }

  subscribe(runId: string, after: number, listener: (e: RunEvent) => void): () => void {
    const run = this.runs.get(runId);
    if (!run) return () => undefined;
    for (const e of run.events) if (e.seq > after) listener(e);
    if (run.finished) return () => undefined;
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  /** Worker 崩溃时，给该用户所有未结束的运行补发错误与结束事件。 */
  failUser(userId: string, message: string) {
    for (const run of this.runs.values()) {
      if (run.userId !== userId || run.finished) continue;
      this.push(userId, run.runId, { type: "error", message });
      this.push(userId, run.runId, { type: "status", status: "failed", message });
      this.push(userId, run.runId, { type: "done", finishReason: "worker-exit" });
    }
  }

  active(userId: string) {
    return [...this.runs.values()].filter((r) => r.userId === userId && !r.finished).map((r) => ({ runId: r.runId, threadId: r.threadId }));
  }

  remove(runId: string) {
    this.runs.delete(runId);
  }
}
