import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveUserFile, saveUpload, workspaceOf } from "./files.ts";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "upload-test-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it("多个客户端同时上传同名中文文件，路径唯一且内容一一对应", async () => {
  const contents = Array.from({length: 12}, (_,i) => `上传者${i}\n${"数据".repeat(40000)}`);
  const results = await Promise.all(contents.map((content) => saveUpload(dir, "local", new File([content], "同名清单.csv", {type:"text/csv"}))));
  expect(new Set(results.map((r) => r.path)).size).toBe(contents.length);
  for (let i = 0; i < results.length; i++) {
    const file = await resolveUserFile(dir, "local", results[i]!.path);
    expect(await fs.readFile(file.abs, "utf8")).toBe(contents[i]);
  }
});

it("已有文件保留，独立账号同名文件隔离", async () => {
  const original = await saveUpload(dir, "alice", new File(["first"], "drawing.dwg"));
  const next = await saveUpload(dir, "alice", new File(["second"], "drawing.dwg"));
  const other = await saveUpload(dir, "bob", new File(["third"], "drawing.dwg"));
  expect(next.path).not.toBe(original.path);
  expect(await fs.readFile((await resolveUserFile(dir,"alice",original.path)).abs,"utf8")).toBe("first");
  expect(await fs.readFile((await resolveUserFile(dir,"bob",other.path)).abs,"utf8")).toBe("third");
});

it("Windows 保留名称、尾部点和空名称归一化，超限文件拒绝", async () => {
  for (const name of ["CON.txt", "AUX", "list.csv. ", "..."]) {
    const result = await saveUpload(dir,"local",new File(["ok"],name));
    expect((await resolveUserFile(dir,"local",result.path)).size).toBe(2);
  }
  await expect(saveUpload(dir,"local",{size:100*1024*1024+1} as File)).rejects.toThrow("100MiB");
});

it("uploads 目录经链接指向工作空间外时拒绝写入", async () => {
  const outside = path.join(dir,"outside");
  const root = workspaceOf(dir,"local");
  await fs.mkdir(root,{recursive:true}); await fs.mkdir(outside);
  await fs.symlink(outside,path.join(root,"uploads"),process.platform==="win32"?"junction":"dir");
  await expect(saveUpload(dir,"local",new File(["no"],"bad.txt"))).rejects.toThrow("工作空间外");
  expect(await fs.readdir(outside)).toEqual([]);
});
