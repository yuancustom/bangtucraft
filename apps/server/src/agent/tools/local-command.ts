import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Redactor } from "../../redact.ts";
import { resolveWorkspacePath } from "../paths.ts";

const OUTPUT_LIMIT = 32 * 1024;
const ENV_WHITELIST = [
  "PATH",
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "HOMEDRIVE",
  "HOMEPATH",
];

export interface CommandResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  executionTimeMs: number;
}

class OutputBuffer {
  private head: Buffer[] = [];
  private headSize = 0;
  private tail = Buffer.alloc(0);
  truncated = false;
  add(chunk: Buffer) {
    const half = OUTPUT_LIMIT / 2;
    if (this.headSize < half) {
      const take = chunk.subarray(0, half - this.headSize);
      this.head.push(take);
      this.headSize += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (!chunk.length) return;
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > half) {
      this.truncated = true;
      this.tail = this.tail.subarray(this.tail.length - half);
    }
  }
  text() {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = this.tail.toString("utf8");
    return this.truncated ? `${head}\n…[输出过长，已截断中间部分]…\n${tail}` : head + tail;
  }
}

export function commandEnvironment(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_WHITELIST) {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key && process.env[key]) env[name] = process.env[key]!;
  }
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  for (const [k, v] of Object.entries(extra)) if (v) env[k] = v;
  return env;
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* 进程已退出 */
    }
  }
}

/** 用 PowerShell 执行一条命令；超时或中止时结束整个进程树。 */
export function runPowerShell(
  command: string,
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<CommandResult> {
  const started = Date.now();
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Continue'\n${command}\nif ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }`;
  return new Promise((resolve) => {
    const stdout = new OutputBuffer();
    const stderr = new OutputBuffer();
    let reason: "timeout" | "aborted" | undefined;
    const child = spawn(
      path.join(options.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stop = (why: "timeout" | "aborted") => {
      if (reason) return;
      reason = why;
      killTree(child.pid);
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    const onAbort = () => stop("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout.on("data", (d: Buffer) => stdout.add(d));
    child.stderr.on("data", (d: Buffer) => stderr.add(d));
    const finish = (code: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const exitCode = reason === "timeout" ? 124 : reason === "aborted" ? 130 : (code ?? 1);
      resolve({
        success: exitCode === 0,
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text() + (reason === "timeout" ? "\n命令超时，已终止。" : reason === "aborted" ? "\n命令已被中止。" : ""),
        timedOut: reason === "timeout",
        killed: Boolean(reason),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        executionTimeMs: Date.now() - started,
      });
    };
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code));
  });
}

const PIP_INSTALL = /(?:^|[\s;&|"'`])(?:pip3?(?:\.exe)?|python(?:3)?(?:\.exe)?\s+-m\s+pip|uv(?:\.exe)?\s+pip)\s+install\b/i;

export interface LocalCommandDeps {
  workspaceRoot: string;
  redactor: Redactor;
  /** 额外注入的环境变量（如 GCMP_DWG_TOOLS）。 */
  extraEnv: () => Record<string, string | undefined>;
  /** 某 Skill 的 Python 环境信息；未准备时返回 undefined。 */
  skillPythonEnv: (skillName: string) => Promise<{ venv: string; scripts: string } | undefined>;
}

export function createLocalCommandTool(deps: LocalCommandDeps) {
  return createTool({
    id: "local_command_execute",
    description:
      "在本机用 PowerShell 执行命令，起始目录为用户工作空间（cwd 为工作空间内相对路径）。命令结束或超时后其子进程一并终止，不要用它启动常驻服务。" +
      "这不是系统沙箱，命令可读写文件和联网。执行 Skill 的 Python 脚本时传 skillName，会自动使用该 Skill 的独立 Python 环境（先用 python_install_packages 准备）。" +
      "不要在命令里用 pip/uv 安装依赖。",
    inputSchema: z.object({
      command: z.string().min(1).max(16384),
      cwd: z.string().max(4096).optional().describe("工作空间内的相对目录，默认工作空间根"),
      timeoutMs: z.number().int().min(1000).max(600000).default(60000),
      skillName: z.string().min(1).max(64).optional(),
    }),
    execute: async ({ command, cwd, timeoutMs, skillName }, context) => {
      if (PIP_INSTALL.test(command)) {
        return { success: false, error: "依赖安装请使用 python_install_packages 工具，不要在终端里安装。" };
      }
      try {
        const directory = await resolveWorkspacePath(deps.workspaceRoot, cwd || ".");
        await fs.mkdir(directory, { recursive: true });
        const extra: Record<string, string | undefined> = { ...deps.extraEnv() };
        if (skillName) {
          const py = await deps.skillPythonEnv(skillName);
          if (!py) return { success: false, error: `Skill ${skillName} 的 Python 环境尚未准备，请先调用 python_install_packages。` };
          extra.VIRTUAL_ENV = py.venv;
          extra.PATH = `${py.scripts};${process.env.PATH ?? ""}`;
        }
        const result = await runPowerShell(command, {
          cwd: directory,
          env: commandEnvironment(extra),
          timeoutMs: timeoutMs ?? 60000,
          signal: context?.abortSignal,
        });
        return { ...result, stdout: deps.redactor.text(result.stdout), stderr: deps.redactor.text(result.stderr) };
      } catch (error) {
        return { success: false, error: deps.redactor.error(error) };
      }
    },
  });
}
