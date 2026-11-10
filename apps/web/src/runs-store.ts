import { useSyncExternalStore } from "react";
import { subscribeRun } from "./api.ts";
import { applyEvent, newRun, type RunView } from "./run-state.ts";

/** 全局运行表：多个会话可同时运行，切换会话不影响后台运行的事件接收。 */
const runs = new Map<string, RunView>();
const stops = new Map<string, () => void>();
const listeners = new Set<() => void>();
let snapshot: RunView[] = [];

const notify = () => {
  snapshot = [...runs.values()];
  for (const l of listeners) l();
};

export function trackRun(runId: string, threadId: string, prompt: string) {
  if (runs.has(runId)) return;
  runs.set(runId, newRun(runId, threadId, prompt));
  notify();
  stops.set(
    runId,
    subscribeRun(
      runId,
      (e) => {
        const current = runs.get(runId);
        if (!current) return;
        const next = applyEvent(current, e);
        // 以服务端第一条事件的时间作为本轮开始时间（刷新后恢复时也准确）。
        if (e.seq === 1) next.startedAt = e.at;
        runs.set(runId, next);
        if (e.type === "done") stops.delete(runId);
        notify();
      },
      () => {
        const current = runs.get(runId);
        if (current && !current.finished) runs.set(runId, { ...current, finished: true, reconnecting: false, status: "failed", blocks: [...current.blocks, { kind: "note", tone: "error", text: "执行端已找不到此任务，请查看会话历史。" }] });
        stops.delete(runId);
        notify();
      },
      (reconnecting) => {
        const current = runs.get(runId);
        if (current && current.reconnecting !== reconnecting) {
          runs.set(runId, { ...current, reconnecting });
          notify();
        }
      },
      (trace) => {
        const current = runs.get(runId);
        if (!current) return;
        // 长时间断线后事件缓存可能已清理，使用本用户的持久化结果恢复，避免重复文字。
        runs.set(runId, { ...current, status: trace.status, finished: true, reconnecting: false,
          blocks: [
            ...(trace.finalText ? [{ kind: "text" as const, text: trace.finalText }] : []),
            ...(trace.files.length ? [{ kind: "files" as const, files: trace.files }] : []),
            ...(trace.error ? [{ kind: "note" as const, tone: "error" as const, text: trace.error }] : []),
          ],
        });
        stops.delete(runId);
        notify();
      },
    ),
  );
}

export function forgetThread(threadId: string) {
  for (const [id, r] of runs) {
    if (r.threadId === threadId) {
      stops.get(id)?.();
      stops.delete(id);
      runs.delete(id);
    }
  }
  notify();
}

export function useRuns(): RunView[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}
