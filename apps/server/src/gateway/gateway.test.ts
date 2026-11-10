import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunEventBody } from "@drawing-agent/shared";
import { createApp, type WorkerCaller } from "../app.ts";
import { modelsFileSchema } from "../models/schema.ts";
import { ModelRegistry } from "../models/registry.ts";
import { Redactor } from "../redact.ts";
import { fakeModelsFile } from "../test-utils/fake-openai.ts";
import { AuthStore, MAX_USERS, type User } from "./auth.ts";
import { CompareStore } from "./compare.ts";
import { OriginalImporter } from "./original.ts";
import { RunHub } from "./run-hub.ts";
import { WorkerPool } from "./worker-pool.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let dir: string;
const closers: (() => unknown)[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-test-"));
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄 */
  }
});

describe("WorkerPool", () => {
  it("每用户独立进程，事件按用户分发，崩溃后通知并在下次调用时重启", async () => {
    const events: [string, string, RunEventBody][] = [];
    const exits: string[] = [];
    const pool = new WorkerPool({
      entry: path.join(here, "..", "test-utils", "fake-worker.mjs"),
      execArgv: [],
      init: (userId) => ({ type: "init", userId }) as never,
      onEvent: (u, r, b) => events.push([u, r, b]),
      onExit: (u) => exits.push(u),
    });
    closers.push(() => pool.close());
    expect(await pool.call("alice", "listThreads")).toEqual([{ id: "t-alice", title: "alice", createdAt: "", updatedAt: "" }]);
    await pool.call("bob", "listThreads");
    expect(pool.pid("alice")).not.toBe(pool.pid("bob"));

    await pool.call("alice", "startRun", "t", {}, "run-a");
    await pool.call("bob", "startRun", "t", {}, "run-b");
    await new Promise((r) => setTimeout(r, 300));
    expect(events.filter(([u]) => u === "alice").every(([, r]) => r === "run-a")).toBe(true);
    expect(events.filter(([, , b]) => b.type === "done")).toHaveLength(2);

    const oldPid = pool.pid("alice");
    await expect(pool.call("alice", "trace")).rejects.toThrow("Worker 已退出");
    expect(exits).toEqual(["alice"]);
    await pool.call("alice", "listThreads");
    expect(pool.pid("alice")).not.toBe(oldPid);
    await expect(pool.call("alice", "nope" as never)).rejects.toThrow("unknown nope");
  }, 30_000);
});

describe("RunHub", () => {
  it("按 runId 缓存、续传、拒绝他人事件、Worker 崩溃时补发失败", () => {
    const hub = new RunHub();
    hub.register("r1", "u1", "t1");
    expect(hub.push("u2", "r1", { type: "text", delta: "偷" })).toBe(false);
    expect(hub.push("u1", "ghost", { type: "text", delta: "x" })).toBe(false);
    hub.push("u1", "r1", { type: "text", delta: "a" });
    hub.push("u1", "r1", { type: "text", delta: "b" });
    const seen: number[] = [];
    hub.subscribe("r1", 1, (e) => seen.push(e.seq));
    expect(seen).toEqual([2]);
    hub.failUser("u1", "崩溃");
    expect(hub.get("r1")!.finished).toBe(true);
    expect(hub.get("r1")!.events.map((e) => e.type)).toEqual(["text", "text", "error", "status", "done"]);
    expect(hub.push("u1", "r1", { type: "text", delta: "迟到" })).toBe(false);
  });
});

function makeApp(workers: WorkerCaller, options: { localUser?: User; auth?: AuthStore } = {}) {
  const auth = options.auth ?? new AuthStore(path.join(dir, "identity.db"));
  if (!options.auth) closers.push(() => auth.close());
  const hub = new RunHub();
  const registry = new ModelRegistry(modelsFileSchema.parse(fakeModelsFile("http://127.0.0.1:1/v1")), { FAKE_API_KEY: "k".repeat(20) });
  const app = createApp({
    auth,
    localUser: options.localUser,
    workers,
    hub,
    registry,
    redactor: new Redactor(),
    dataDir: dir,
    evalsDir: path.join(dir, "evals"),
    skills: { skills: [], problems: [], tiers: {} },
    original: new OriginalImporter(undefined, path.join(dir, "snap")),
    compares: new CompareStore((u) => path.join(dir, "users", u, "compares")),
  });
  return { app, hub, auth };
}

async function login(app: ReturnType<typeof createApp>, username: string, register = true) {
  const res = await app.request(`/api/auth/${register ? "register" : "login"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password-123" }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, user: ((await res.json()) as { user: { id: string } }).user };
}

describe("网关接口", () => {
  it("免登录访客通过 multipart 上传中文文件并下载原始内容，无需宿主机路径", async () => {
    const seeded=makeApp({call:async()=>[] as never});
    const localUser=await seeded.auth.localUser();
    const {app}=makeApp({call:async()=>[] as never},{auth:seeded.auth,localUser});
    const form=new FormData();
    form.append("file",new File(["楼层,数量\n一层,7"],"访客清单.csv",{type:"text/csv"}));
    const upload=await app.request("/api/files/upload",{method:"POST",body:form});
    expect(upload.status).toBe(200);
    const result=await upload.json();
    expect(result.path).toMatch(/^uploads\//);
    const downloaded=await app.request(`/api/files/raw?path=${encodeURIComponent(result.path)}&download=1`);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("楼层,数量\n一层,7");
    expect(downloaded.headers.get("content-disposition")).toContain("attachment");
  });
  it("免登录访问复用原用户的会话、文件和 SSE，旧 Cookie 不切换工作空间", async () => {
    const calls: [string, string][] = [];
    const workers: WorkerCaller = { call: async (userId, method) => {
      calls.push([userId, method]);
      return [{ id: "existing-thread", title: "原有建模会话" }] as never;
    } };
    const seeded = makeApp(workers);
    const original = await login(seeded.app, "original");
    const other = await login(seeded.app, "other");
    const localUser = await seeded.auth.localUser(original.user.id);
    const { app, hub } = makeApp(workers, { auth: seeded.auth, localUser });
    for (const headers of [new Headers(), new Headers({ cookie: other.cookie })]) {
      const status = await (await app.request("/api/auth/status", { headers })).json();
      expect(status).toMatchObject({ user: localUser, loginRequired: false, canRegister: false });
      const sessions = await (await app.request("/api/sessions", { headers })).json();
      expect(sessions.sessions[0].title).toBe("原有建模会话");
      await app.request("/api/sessions/existing-thread/messages", { headers });
    }
    expect((await app.request("/api/sessions", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status).toBe(200);
    expect(calls.every(([id]) => id === original.user.id)).toBe(true);
    expect(calls.some(([, method]) => method === "createThread")).toBe(true);

    const workspace = path.join(dir, "users", original.user.id, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "model.html"), "<p>existing model</p>");
    const model = await app.request("/api/files/raw?path=model.html");
    expect(model.status).toBe(200);
    expect(await model.text()).toContain("existing model");
    expect((await app.request("/api/files/raw?path=../identity.db")).status).toBe(404);
    hub.register("local-run", localUser.id, "existing-thread");
    hub.push(localUser.id, "local-run", { type: "done", finishReason: "stop" });
    expect(await (await app.request("/api/runs/local-run/events")).text()).toContain('"type":"done"');
  });

  it("免登录仍拒绝跨源写入并禁用账号切换和注册", async () => {
    const seeded = makeApp({ call: async () => [] as never });
    const localUser = await seeded.auth.localUser();
    const { app } = makeApp({ call: async () => [] as never }, { auth: seeded.auth, localUser });
    expect((await app.request("/api/sessions", { method: "POST", headers: { origin: "http://evil.test", host: "localhost" } })).status).toBe(403);
    for (const route of ["login", "register"]) {
      expect((await app.request(`/api/auth/${route}`, { method: "POST" })).status).toBe(403);
    }
    await app.request("/api/auth/logout", { method: "POST" });
    expect((await app.request("/api/sessions")).status).toBe(200);
    expect(await seeded.auth.userCount()).toBe(1);
  });

  it("注册上限、登录、未登录拒绝", async () => {
    const { app } = makeApp({ call: async () => [] as never });
    expect((await app.request("/api/sessions")).status).toBe(401);
    for (let i = 0; i < MAX_USERS; i++) await login(app, `user${i}`);
    const extra = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "user9", password: "password-123" }),
    });
    expect(extra.status).toBe(403);
    const bad = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "user0", password: "wrong-password" }),
    });
    expect(bad.status).toBe(401);
    const { cookie } = await login(app, "user0", false);
    expect((await app.request("/api/sessions", { headers: { cookie } })).status).toBe(200);
  });

  it("两个用户的会话、运行与文件互相隔离；SSE 可续传", async () => {
    const calls: [string, string][] = [];
    const ref: { hub?: RunHub } = {};
    const workers: WorkerCaller = {
      call: async (userId, method, ...params) => {
        calls.push([userId, method]);
        if (method === "startRun") {
          const runId = params[2] as string;
          setTimeout(() => {
            ref.hub!.push(userId, runId, { type: "text", delta: "hi" });
            ref.hub!.push(userId, runId, { type: "done", finishReason: "stop" });
          }, 10);
        }
        return [] as never;
      },
    };
    const { app, hub } = makeApp(workers);
    ref.hub = hub;
    const a = await login(app, "alice");
    const b = await login(app, "bob");
    await app.request("/api/sessions", { headers: { cookie: b.cookie } });
    expect(calls.at(-1)).toEqual([b.user.id, "listThreads"]);

    const send = await app.request("/api/sessions/t1/messages", {
      method: "POST",
      headers: { cookie: a.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    });
    const { runId } = (await send.json()) as { runId: string };
    expect((await app.request(`/api/runs/${runId}/events`, { headers: { cookie: b.cookie } })).status).toBe(404);
    expect((await app.request(`/api/runs/${runId}/abort`, { method: "POST", headers: { cookie: b.cookie } })).status).toBe(404);

    await new Promise((r) => setTimeout(r, 50));
    const sse = await (await app.request(`/api/runs/${runId}/events?after=1`, { headers: { cookie: a.cookie } })).text();
    expect(sse).not.toContain('"delta":"hi"');
    expect(sse).toContain('"type":"done"');

    const wsA = path.join(dir, "users", a.user.id, "workspace");
    fs.mkdirSync(wsA, { recursive: true });
    fs.writeFileSync(path.join(wsA, "a.html"), "<p>a</p>");
    const own = await app.request("/api/files/raw?path=a.html", { headers: { cookie: a.cookie } });
    expect(own.status).toBe(200);
    expect(own.headers.get("content-security-policy")).toContain("sandbox");
    expect((await app.request("/api/files/raw?path=a.html", { headers: { cookie: b.cookie } })).status).toBe(404);
    expect((await app.request(`/api/files/raw?path=../${a.user.id}/workspace/a.html`, { headers: { cookie: b.cookie } })).status).toBe(404);
  });

  it("未知模型与非法请求被拒", async () => {
    const { app } = makeApp({ call: async () => [] as never });
    const { cookie } = await login(app, "carol");
    const res = await app.request("/api/sessions/t1/messages", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x", model: "gpt-unknown" }),
    });
    expect(res.status).toBe(400);
    const cross = await app.request("/api/sessions", { method: "POST", headers: { cookie, origin: "http://evil.test", host: "localhost" } });
    expect(cross.status).toBe(403);
  });
});
