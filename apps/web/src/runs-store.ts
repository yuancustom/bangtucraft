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
        if (current && !current.finished) runs.set(runId, { ...current, finished: true, status: "failed" });
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
