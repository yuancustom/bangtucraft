import { fork, type ChildProcess } from "node:child_process";
import type { RunEventBody } from "@drawing-agent/shared";
import type { WorkerInit, WorkerMessage, WorkerMethod } from "./protocol.ts";

interface Handle {
  child: ChildProcess;
  ready: Promise<void>;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  alive: boolean;
}

export interface WorkerPoolOptions {
  entry: string;
  execArgv?: string[];
  init: (userId: string) => WorkerInit;
  onEvent: (userId: string, runId: string, body: RunEventBody) => void;
  /** Worker 意外退出（不含主动关闭）。 */
  onExit: (userId: string) => void;
  requestTimeoutMs?: number;
  readyTimeoutMs?: number;
}

/** 每用户一个 Worker 子进程；按需启动，崩溃后下次请求自动重启。 */
export class WorkerPool {
  private handles = new Map<string, Handle>();
  private nextId = 1;
  private closing = false;

  constructor(private readonly options: WorkerPoolOptions) {}

  private start(userId: string): Handle {
    const child = fork(this.options.entry, [], {
      execArgv: this.options.execArgv ?? process.execArgv,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "advanced",
    });
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let markReady!: () => void;
    let failReady!: (e: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    ready.catch(() => undefined);
    const readyTimer = setTimeout(() => failReady(new Error("Worker 启动超时")), this.options.readyTimeoutMs ?? 60_000);
    const handle: Handle = { child, ready, pending, alive: true };
    child.on("message", (message: WorkerMessage) => {
      if (message.type === "ready") {
        clearTimeout(readyTimer);
        markReady();
      } else if (message.type === "response") {
        const p = pending.get(message.id);
        if (!p) return;
        pending.delete(message.id);
        if (message.ok) p.resolve(message.result);
        else p.reject(new Error(message.error));
      } else if (message.type === "event") {
        this.options.onEvent(userId, message.runId, message.body);
      }
    });
    child.once("exit", () => {
      clearTimeout(readyTimer);
      handle.alive = false;
      failReady(new Error("Worker 已退出"));
      for (const p of pending.values()) p.reject(new Error("Worker 已退出，请重试"));
      pending.clear();
      if (this.handles.get(userId) === handle) this.handles.delete(userId);
      if (!this.closing) this.options.onExit(userId);
    });
    child.send(this.options.init(userId));
    this.handles.set(userId, handle);
    return handle;
  }

  private get(userId: string): Handle {
    const existing = this.handles.get(userId);
    if (existing?.alive) return existing;
    return this.start(userId);
  }

  async call<T = unknown>(userId: string, method: WorkerMethod, ...params: unknown[]): Promise<T> {
    const handle = this.get(userId);
    await handle.ready;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.pending.delete(id);
        reject(new Error(`Worker 调用超时：${method}`));
      }, this.options.requestTimeoutMs ?? 120_000);
      handle.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      handle.child.send({ type: "request", id, method, params });
    });
  }

  pid(userId: string): number | undefined {
    return this.handles.get(userId)?.child.pid;
  }

  kill(userId: string) {
    this.handles.get(userId)?.child.kill();
  }

  async close() {
    this.closing = true;
    const exits = [...this.handles.values()].map(
      (h) =>
        new Promise<void>((resolve) => {
          if (!h.alive) return resolve();
          const timer = setTimeout(() => {
            h.child.kill();
            resolve();
          }, 5000);
          h.child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          h.child.disconnect();
        }),
    );
    await Promise.all(exits);
    this.handles.clear();
  }
}
