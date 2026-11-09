// Windows 执行端；密钥仅从仓库根目录 .env 读取，不传给 Docker。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const values = require("dotenv").parse(fs.readFileSync(path.join(root, ".env")));
// 只在此进程及其子进程中覆盖监听地址；不修改用户的 .env。
const env = { ...process.env, ...values, HOST: "0.0.0.0", PORT: "8787" };
const children = [["apps/server", "src/index.ts"], ["packages/search-mcp", "src/server.ts"]].map(([dir, entry]) =>
  spawn(process.execPath, ["--import", "tsx", entry], { cwd: path.join(root, dir), env, stdio: "inherit", windowsHide: true }),
);
let stopping = false;
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
for (const child of children) {
  child.on("error", () => { console.error("Windows Agent 启动失败，请检查 Node 与依赖。"); stop(1); });
  child.on("exit", (code) => stop(code ?? 1));
}
