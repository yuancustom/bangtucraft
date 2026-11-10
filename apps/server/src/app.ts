import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { HealthResponse, RunEvent, RunTrace, SkillInfo, ThreadSummary } from "@drawing-agent/shared";
import { DEFAULT_PERMISSION_MODE } from "@drawing-agent/shared";
import type { SkillCatalog } from "./agent/skills.ts";
import { AuthError, MAX_USERS, type AuthStore, type User } from "./gateway/auth.ts";
import {
  DEFAULT_RUBRIC,
  buildJudgePrompt,
  checkAssertions,
  loadEvalCases,
  metricsFromOriginal,
  metricsFromTrace,
  parseJudge,
  type CompareColumn,
  type CompareStore,
} from "./gateway/compare.ts";
import { previewHtml, resolveUserFile, saveUpload } from "./gateway/files.ts";
import type { OriginalImporter } from "./gateway/original.ts";
import type { RunHub } from "./gateway/run-hub.ts";
import type { WorkerMethod } from "./gateway/protocol.ts";
import { discoverModels, streamChat } from "./models/openai-compat.ts";
import type { ModelRegistry } from "./models/registry.ts";
import type { Redactor } from "./redact.ts";

/** 网关调用 Worker 的抽象，测试时可替换为假实现。 */
export interface WorkerCaller {
  call<T = unknown>(userId: string, method: WorkerMethod, ...params: unknown[]): Promise<T>;
}

export interface GatewayDeps {
  auth: AuthStore;
  /** 设定后所有访问都使用同一本地工作空间，无需登录 Cookie。 */
  localUser?: User;
  workers: WorkerCaller;
  hub: RunHub;
  registry: ModelRegistry;
  redactor: Redactor;
  dataDir: string;
  evalsDir: string;
  skills: SkillCatalog;
  original: OriginalImporter;
  compares: CompareStore;
  /** 生产环境下托管前端构建产物。 */
  webDist?: string;
}

type Env = { Variables: { user: User } };
const COOKIE = "sid";

const sendSchema = z.object({
  text: z.string().min(1).max(100_000),
  model: z.string().min(1).default("auto"),
  permissionMode: z.enum(["request", "full-access"]).default(DEFAULT_PERMISSION_MODE),
  skills: z.array(z.string().max(64)).max(10).optional(),
  images: z.array(z.string().max(4096)).max(8).optional(),
});

const planSchemaLite = z.object({
  action: z.enum(["approve", "reject", "revise"]),
  feedback: z.string().max(4000).optional(),
});

export function createApp(deps?: GatewayDeps) {
  const app = new Hono<Env>();
  app.get("/health", (c) => c.json<HealthResponse>({ status: "ok" }));
  if (!deps) return app;
  const { auth, workers, hub, registry, redactor } = deps;

  const fail = (c: Context, error: unknown, status: 400 | 401 | 403 | 404 | 409 | 500 = 400) => {
    if (error instanceof AuthError) return c.json({ error: error.message }, error.status);
    return c.json({ error: redactor.error(error) }, status);
  };

  // ---------------- 认证 ----------------
  const credentials = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(128) });
  const issue = (c: Context, token: string) =>
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Strict", path: "/", maxAge: 30 * 24 * 3600 });

  app.get("/api/auth/status", async (c) => {
    const user = deps.localUser ?? await auth.userForToken(getCookie(c, COOKIE));
    const count = await auth.userCount();
    return c.json({ user: user ?? null, loginRequired: !deps.localUser, canRegister: !deps.localUser && count < MAX_USERS, maxUsers: MAX_USERS });
  });
  app.post("/api/auth/register", async (c) => {
    if (deps.localUser) return c.json({ error: "当前使用免登录工作空间" }, 403);
    try {
      const body = credentials.parse(await c.req.json());
      await auth.register(body.username, body.password);
      const { user, token } = await auth.login(body.username, body.password);
      issue(c, token);
      return c.json({ user });
    } catch (error) {
      return fail(c, error);
    }
  });
  app.post("/api/auth/login", async (c) => {
    if (deps.localUser) return c.json({ error: "当前使用免登录工作空间" }, 403);
    try {
      const body = credentials.parse(await c.req.json());
      const { user, token } = await auth.login(body.username, body.password);
      issue(c, token);
      return c.json({ user });
    } catch (error) {
      return fail(c, error);
    }
  });
  app.post("/api/auth/logout", async (c) => {
    if (deps.localUser) return c.json({ ok: true });
    await auth.logout(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth/")) return next();
    const user = deps.localUser ?? await auth.userForToken(getCookie(c, COOKIE));
    if (!user) return c.json({ error: "未登录" }, 401);
    // 防 CSRF：改动类请求必须来自同源页面（fetch 会带 Origin）。
    if (c.req.method !== "GET") {
      const origin = c.req.header("origin");
      if (origin && new URL(origin).host !== c.req.header("host")) return c.json({ error: "来源不被允许" }, 403);
    }
    c.set("user", user);
    return next();
  });

  // ---------------- 模型与技能 ----------------
  app.get("/api/models", (c) => c.json({ models: registry.list(), roles: registry.file.roles }));
  app.post("/api/models/:id/ping", async (c) => {
    const id = c.req.param("id");
    if (!registry.has(id)) return c.json({ error: "未知模型" }, 404);
    try {
      const r = await streamChat(registry, redactor, id, [{ role: "user", content: "只回复 ok" }], { maxTokens: 50, timeoutMs: 60_000 });
      return c.json({ ok: true, latencyMs: r.latencyMs, reply: r.text.slice(0, 100) });
    } catch (error) {
      return c.json({ ok: false, error: redactor.error(error) });
    }
  });
  app.get("/api/models/discover/:provider", async (c) => {
    try {
      return c.json({ models: await discoverModels(registry, redactor, c.req.param("provider")) });
    } catch (error) {
      return fail(c, error);
    }
  });
  app.get("/api/skills", (c) =>
    c.json({
      skills: deps.skills.skills.map(({ name, description, source, tier }): SkillInfo => ({ name, description, source, tier })),
      problems: deps.skills.problems.map((p) => ({ name: p.path.split(/[\\/]/).pop(), source: p.source, errors: p.errors })),
    }),
  );

  // ---------------- 会话 ----------------
  const uid = (c: Context<Env>) => c.get("user").id;
  app.get("/api/sessions", async (c) => {
    try {
      return c.json({ sessions: await workers.call<ThreadSummary[]>(uid(c), "listThreads"), active: hub.active(uid(c)) });
    } catch (error) {
      return fail(c, error, 500);
    }
  });
  app.post("/api/sessions", async (c) => {
    try {
      const body = z.object({ title: z.string().max(100).optional() }).parse(await c.req.json().catch(() => ({})));
      return c.json({ session: await workers.call(uid(c), "createThread", body.title) });
    } catch (error) {
      return fail(c, error);
    }
  });
  app.patch("/api/sessions/:id", async (c) => {
    try {
      const body = z.object({ title: z.string().trim().min(1).max(100) }).parse(await c.req.json());
      await workers.call(uid(c), "renameThread", c.req.param("id"), body.title);
      return c.json({ ok: true });
    } catch (error) {
      return fail(c, error);
    }
  });
  app.delete("/api/sessions/:id", async (c) => {
    try {
      await workers.call(uid(c), "deleteThread", c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      return fail(c, error);
    }
  });
  app.get("/api/sessions/:id/messages", async (c) => {
    try {
      return c.json({ messages: await workers.call(uid(c), "history", c.req.param("id")) });
    } catch (error) {
      return fail(c, error, 404);
    }
  });
  app.get("/api/sessions/:id/runs", async (c) => {
    try {
      return c.json({ runs: await workers.call(uid(c), "traceList", c.req.param("id")) });
    } catch (error) {
      return fail(c, error);
    }
  });

  const startRun = async (userId: string, threadId: string, body: z.infer<typeof sendSchema>) => {
    const runId = randomUUID();
    hub.register(runId, userId, threadId);
    try {
      await workers.call(userId, "startRun", threadId, body, runId);
    } catch (error) {
      hub.remove(runId);
      throw error;
    }
    return runId;
  };

  app.post("/api/sessions/:id/messages", async (c) => {
    try {
      const body = sendSchema.parse(await c.req.json());
      if (body.model !== "auto" && !registry.has(body.model)) return c.json({ error: "未知模型" }, 400);
      return c.json({ runId: await startRun(uid(c), c.req.param("id"), body) });
    } catch (error) {
      return fail(c, error);
    }
  });

  // ---------------- 运行 ----------------
  const ownRun = (c: Context<Env>) => {
    const run = hub.get(c.req.param("runId")!);
    return run && run.userId === uid(c) ? run : undefined;
  };

  app.get("/api/runs/active", (c) => c.json({ runs: hub.active(uid(c)) }));
  // 断线后用普通请求区分网页入口暂不可用、运行存在、以及事件缓存已过期。
  app.get("/api/runs/:runId", async (c) => {
    const run = ownRun(c);
    if (run) return c.json({ exists: true });
    try {
      const trace = await workers.call<RunTrace | null>(uid(c), "trace", c.req.param("runId"));
      if (trace && ["completed", "failed", "cancelled"].includes(trace.status)) return c.json({ trace });
    } catch {
      return c.json({ error: "执行端暂不可用，等待重连" }, 503);
    }
    return c.json({ error: "运行不存在或已过期" }, 404);
  });
  app.get("/api/runs/:runId/events", (c) => {
    const run = ownRun(c);
    if (!run) return c.json({ error: "运行不存在或已过期" }, 404);
    const after = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      const queue: RunEvent[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      const unsubscribe = hub.subscribe(run.runId, after, (e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        ended = true;
        wake?.();
      });
      try {
        while (!ended) {
          while (queue.length) {
            const e = queue.shift()!;
            await stream.writeSSE({ id: String(e.seq), event: "run", data: JSON.stringify(e) });
            if (e.type === "done") ended = true;
          }
          if (ended) break;
          await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(15_000)]);
          wake = undefined;
          if (!queue.length && !ended) await stream.writeSSE({ event: "ping", data: "{}" });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  const runAction = (method: WorkerMethod, schema: z.ZodType, toParams: (body: any, runId: string) => unknown[]) =>
    app.post(`/api/runs/:runId/${method === "respondApproval" ? "approval" : method === "respondQuestion" ? "question" : method === "decidePlan" ? "plan" : "abort"}`, async (c) => {
      const run = ownRun(c);
      if (!run) return c.json({ error: "运行不存在或已过期" }, 404);
      try {
        const body = schema.parse(await c.req.json().catch(() => ({})));
        await workers.call(uid(c), method, ...toParams(body, run.runId));
        return c.json({ ok: true });
      } catch (error) {
        return fail(c, error);
      }
    });
  runAction(
    "respondApproval",
    z.object({ toolCallId: z.string().min(1), approved: z.boolean(), reason: z.string().max(1000).optional() }),
    (b, runId) => [runId, b.toolCallId, b.approved, b.reason],
  );
  runAction(
    "respondQuestion",
    z.object({ toolCallId: z.string().min(1), selectedIds: z.array(z.string()).optional(), text: z.string().max(10_000).optional() }),
    (b, runId) => [runId, b.toolCallId, { selectedIds: b.selectedIds, text: b.text }],
  );
  runAction("decidePlan", planSchemaLite, (b, runId) => [runId, b]);
  runAction("abortRun", z.object({}).passthrough(), (_b, runId) => [runId]);

  // ---------------- 文件 ----------------
  app.get("/api/files/raw", async (c) => {
    try {
      const file = await resolveUserFile(deps.dataDir, uid(c), c.req.query("path") ?? "");
      const headers: Record<string, string> = {
        "Content-Type": file.mediaType.startsWith("text/") ? `${file.mediaType}; charset=utf-8` : file.mediaType,
        "Content-Length": String(file.size),
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `${c.req.query("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      };
      // HTML / SVG 成果在独立沙箱源中运行，不能访问本站 Cookie 与接口。
      if (/html|svg/.test(file.mediaType)) headers["Content-Security-Policy"] = "sandbox allow-scripts allow-popups allow-downloads";
      return new Response(fs.createReadStream(file.abs) as unknown as ReadableStream, { headers });
    } catch (error) {
      return fail(c, error, 404);
    }
  });
  app.get("/api/files/preview", async (c) => {
    try {
      const file = await resolveUserFile(deps.dataDir, uid(c), c.req.query("path") ?? "");
      return c.json({ html: await previewHtml(file.abs) });
    } catch (error) {
      return fail(c, error);
    }
  });
  app.post("/api/files/upload", async (c) => {
    try {
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) return c.json({ error: "缺少文件" }, 400);
      return c.json(await saveUpload(deps.dataDir, uid(c), file));
    } catch (error) {
      return fail(c, error);
    }
  });

  // ---------------- 对比 ----------------
  app.get("/api/evals/cases", (c) => c.json(loadEvalCases(deps.evalsDir)));
  app.get("/api/original/threads", (c) => {
    if (!deps.original.available()) return c.json({ available: false, threads: [] });
    try {
      return c.json({ available: true, threads: deps.original.listThreads() });
    } catch (error) {
      return fail(c, error, 500);
    }
  });
  app.get("/api/original/threads/:id", (c) => {
    try {
      return c.json({ turns: deps.original.turns(c.req.param("id")) });
    } catch (error) {
      return fail(c, error);
    }
  });

  const compareSchema = z.object({
    prompt: z.string().min(1).max(100_000).optional(),
    caseId: z.string().optional(),
    permissionMode: z.enum(["request", "full-access"]).default(DEFAULT_PERMISSION_MODE),
    replicas: z.array(z.object({ label: z.string().min(1).max(40), model: z.string().min(1) })).max(6).default([]),
    original: z.object({ threadId: z.string().min(1), turnIndex: z.number().int().min(0) }).optional(),
  });

  app.get("/api/compare", (c) => c.json({ compares: deps.compares.list(uid(c)).map(({ id, title, createdAt }) => ({ id, title, createdAt })) }));
  app.post("/api/compare", async (c) => {
    try {
      const body = compareSchema.parse(await c.req.json());
      const evalCase = body.caseId ? loadEvalCases(deps.evalsDir).cases.find((x) => x.id === body.caseId) : undefined;
      if (body.caseId && !evalCase) return c.json({ error: "评测用例不存在" }, 404);
      let prompt = body.prompt ?? evalCase?.prompt;
      const columns: CompareColumn[] = [];
      if (body.original) {
        const turn = deps.original.turns(body.original.threadId)[body.original.turnIndex];
        if (!turn) return c.json({ error: "原版会话中没有该轮" }, 404);
        prompt ??= turn.userText;
        columns.push({
          kind: "original",
          label: "原版帮图Mind",
          originalThreadId: body.original.threadId,
          turnIndex: body.original.turnIndex,
          snapshot: metricsFromOriginal(turn),
          userText: turn.userText,
        });
      }
      if (!prompt) return c.json({ error: "缺少问题" }, 400);
      if (!body.replicas.length && !columns.length) return c.json({ error: "至少选择一列" }, 400);
      for (const r of body.replicas) {
        if (r.model !== "auto" && !registry.has(r.model)) return c.json({ error: `未知模型：${r.model}` }, 400);
        const thread = await workers.call<ThreadSummary>(uid(c), "createThread", `[对比] ${r.label}：${prompt.slice(0, 20)}`);
        const runId = await startRun(uid(c), thread.id, { text: prompt, model: r.model, permissionMode: body.permissionMode });
        columns.push({ kind: "replica", label: r.label, model: r.model, threadId: thread.id, runId });
      }
      const record = deps.compares.create(uid(c), {
        title: evalCase?.title ?? prompt.slice(0, 40),
        prompt,
        caseId: evalCase?.id,
        rubric: evalCase?.rubric ?? DEFAULT_RUBRIC,
        assertions: evalCase?.assertions ?? [],
        columns,
      });
      return c.json({ compare: record });
    } catch (error) {
      return fail(c, error);
    }
  });

  const resolveColumns = async (userId: string, id: string) => {
    const record = deps.compares.get(userId, id);
    const columns = await Promise.all(
      record.columns.map(async (col) => {
        if (col.kind === "original") return { ...col, metrics: col.snapshot };
        const trace = await workers.call<RunTrace | undefined>(userId, "trace", col.runId).catch(() => undefined);
        const live = hub.get(col.runId);
        return { ...col, metrics: metricsFromTrace(trace ?? undefined, live && !live.finished ? "running" : "unknown") };
      }),
    );
    return {
      record,
      columns: columns.map((col) => ({ ...col, assertions: checkAssertions(record.assertions, col.metrics) })),
    };
  };

  app.get("/api/compare/:id", async (c) => {
    try {
      const { record, columns } = await resolveColumns(uid(c), c.req.param("id"));
      return c.json({ compare: { ...record, columns } });
    } catch (error) {
      return fail(c, error, 404);
    }
  });
  app.post("/api/compare/:id/judge", async (c) => {
    try {
      const { record, columns } = await resolveColumns(uid(c), c.req.param("id"));
      const judge = registry.role("judge");
      const prompt = buildJudgePrompt(
        record.prompt,
        record.rubric,
        columns.map((col) => ({ label: col.label, metrics: col.metrics })),
      );
      const r = await streamChat(registry, redactor, judge.id, [{ role: "user", content: prompt }], { timeoutMs: 180_000 });
      const result = parseJudge(r.text);
      record.judge = { modelId: judge.id, result, at: new Date().toISOString() };
      deps.compares.save(uid(c), record);
      return c.json({ judge: record.judge });
    } catch (error) {
      return fail(c, error);
    }
  });

  // ---------------- 前端静态文件 ----------------
  if (deps.webDist && fs.existsSync(deps.webDist)) {
    const dist = deps.webDist;
    app.get("*", async (c) => {
      const rel = c.req.path === "/" ? "index.html" : decodeURIComponent(c.req.path.slice(1));
      const target = path.resolve(dist, rel);
      const inside = target.startsWith(path.resolve(dist) + path.sep);
      const file = inside && fs.existsSync(target) && fs.statSync(target).isFile() ? target : path.join(dist, "index.html");
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8";
      return new Response(fs.readFileSync(file), { headers: { "Content-Type": type } });
    });
  }

  return app;
}
