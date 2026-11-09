// 每用户一个的 Worker 子进程：持有该用户的 Mastra Agent、记忆库与工作空间。
import { UserRuntime } from "../agent/runtime.ts";
import { ModelRegistry } from "../models/registry.ts";
import { setupNetwork } from "../network.ts";
import { Redactor } from "../redact.ts";
import type { WorkerInit, WorkerMessage, WorkerRequest } from "./protocol.ts";

let runtime: UserRuntime | undefined;
let redactor = new Redactor();

const send = (message: WorkerMessage) => process.send?.(message);

async function init(data: WorkerInit) {
  redactor = new Redactor(Object.values(data.secrets));
  const registry = new ModelRegistry(data.models, data.secrets);
  setupNetwork({
    httpsProxy: data.network.httpsProxy,
    noProxy: data.network.noProxy,
    models: data.models,
    resolveBaseUrl: (id) => registry.baseUrl(id),
  });
  runtime = new UserRuntime({
    userId: data.userId,
    userDir: data.userDir,
    rootDir: data.rootDir,
    registry,
    redactor,
    secrets: data.secrets,
    skills: data.skills,
    mcp: data.mcp,
    python: data.python,
    extraEnv: data.extraEnv,
    emit: (runId, body) => send({ type: "event", runId, body }),
  });
  await runtime.init();
  send({ type: "ready" });
}

async function handle(req: WorkerRequest) {
  try {
    if (!runtime) throw new Error("Worker 尚未初始化");
    const fn = (runtime as unknown as Record<string, (...a: unknown[]) => unknown>)[req.method];
    if (typeof fn !== "function") throw new Error(`未知方法：${req.method}`);
    const result = await fn.apply(runtime, req.params);
    send({ type: "response", id: req.id, ok: true, result: result ?? null });
  } catch (error) {
    send({ type: "response", id: req.id, ok: false, error: redactor.error(error) });
  }
}

process.on("message", (message: WorkerInit | WorkerRequest) => {
  if (message.type === "init") void init(message).catch((e) => {
    console.error("[worker] 初始化失败：", redactor.error(e));
    process.exit(1);
  });
  else if (message.type === "request") void handle(message);
});

process.on("disconnect", () => {
  void runtime?.close().finally(() => process.exit(0));
});

process.on("unhandledRejection", (error) => {
  console.error("[worker] 未处理的异常：", redactor.error(error));
});
