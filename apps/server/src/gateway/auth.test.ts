import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuthStore } from "./auth.ts";

let dir: string;
let store: AuthStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-auth-"));
  store = new AuthStore(path.join(dir, "identity.db"));
});
afterEach(() => {
  store.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    // Windows 下 libsql 原生句柄可能延迟释放，保留临时目录等待系统清理。
    if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
});

it("空库并发访问创建同一本地工作空间，重启后继续复用", async () => {
  const users = await Promise.all(Array.from({ length: 12 }, () => store.localUser()));
  expect(new Set(users.map((user) => user.id)).size).toBe(1);
  expect(await store.userCount()).toBe(1);
  store.close();
  store = new AuthStore(path.join(dir, "identity.db"));
  expect(await store.localUser()).toEqual(users[0]);
});

it("指定已有用户时复用其身份，未指定时保留最早用户", async () => {
  const first = await store.register("first", "password-123");
  const second = await store.register("second", "password-456");
  expect(await store.localUser(second.id)).toEqual(second);
  expect(await store.localUser()).toEqual(first);
  expect(await store.userCount()).toBe(2);
});

it("用户 ID 配错时拒绝启动，避免建立空工作空间掩盖原有数据", async () => {
  await expect(store.localUser("missing-user")).rejects.toThrow("LOCAL_USER_ID");
  expect(await store.userCount()).toBe(0);
});
