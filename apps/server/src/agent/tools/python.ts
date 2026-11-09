import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Redactor } from "../../redact.ts";
import { commandEnvironment } from "./local-command.ts";

const IMPORT_NAME_HINTS: Record<string, string> = {
  pil: "Pillow",
  cv2: "opencv-python",
  docx: "python-docx",
  pptx: "python-pptx",
  yaml: "PyYAML",
  sklearn: "scikit-learn",
  skimage: "scikit-image",
  fitz: "PyMuPDF",
  bs4: "beautifulsoup4",
};
const PACKAGE_SPEC =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?((==|>=|<=|~=|!=|>|<)[A-Za-z0-9.*+!_-]+)?(,(==|>=|<=|~=|!=|>|<)[A-Za-z0-9.*+!_-]+)*$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GENERAL = "_general";

export function validatePackages(packages: string[]): string | undefined {
  for (const spec of packages) {
    if (!PACKAGE_SPEC.test(spec)) return `包名不合法或使用了 URL / 路径：${spec}`;
    const name = spec.split(/[[<>=!~,]/)[0]!.toLowerCase();
    const hint = IMPORT_NAME_HINTS[name];
    if (hint) return `${spec} 是导入名，发行包名应为 ${hint}`;
  }
  return undefined;
}

export interface PythonManagerOptions {
  uvExe: string;
  root: string;
  indexUrl: string;
  pythonVersion?: string;
  httpsProxy?: string;
  redactor: Redactor;
}

/** 按 Skill 隔离的 Python 环境（uv 管理），只安装 wheel。 */
export class PythonManager {
  private locks = new Map<string, Promise<unknown>>();
  constructor(readonly options: PythonManagerOptions) {}

  envDir(skillName?: string) {
    const name = skillName ?? GENERAL;
    if (skillName && !SKILL_NAME.test(skillName)) throw new Error("skillName 不合法");
    return path.join(this.options.root, "envs", name);
  }

  pythonExe(skillName?: string) {
    return path.join(this.envDir(skillName), process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
  }

  status(skillName?: string) {
    const python = this.pythonExe(skillName);
    return { ready: fs.existsSync(python), python, environment: this.envDir(skillName) };
  }

  async envInfo(skillName: string) {
    const s = this.status(skillName);
    return s.ready ? { venv: s.environment, scripts: path.dirname(s.python) } : undefined;
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.locks.set(key, next);
    return next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    });
  }

  private run(args: string[], signal?: AbortSignal): Promise<{ code: number; output: string }> {
    const env = commandEnvironment({
      UV_CACHE_DIR: path.join(this.options.root, "cache"),
      UV_PYTHON_INSTALL_DIR: path.join(this.options.root, "pythons"),
      UV_NO_PROGRESS: "1",
      HTTPS_PROXY: this.options.httpsProxy,
      HTTP_PROXY: this.options.httpsProxy,
    });
    return new Promise((resolve) => {
      const child = spawn(this.options.uvExe, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const add = (d: Buffer) => {
        output = (output + d.toString("utf8")).slice(-8000);
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const timer = setTimeout(() => child.kill(), 10 * 60_000);
      const onAbort = () => child.kill();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", (e) => {
        clearTimeout(timer);
        resolve({ code: 1, output: `无法启动 uv：${e.message}` });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ code: code ?? 1, output });
      });
    });
  }

  prepare(skillName?: string, signal?: AbortSignal) {
    return this.withLock(skillName ?? GENERAL, async () => {
      const s = this.status(skillName);
      if (s.ready) return { success: true, ...s, created: false };
      fs.mkdirSync(path.dirname(s.environment), { recursive: true });
      const r = await this.run(["venv", "--python", this.options.pythonVersion ?? "3.13", s.environment], signal);
      if (r.code !== 0) return { success: false, error: `创建环境失败：${this.options.redactor.text(r.output.slice(-1500))}` };
      return { success: true, ...this.status(skillName), created: true };
    });
  }

  async install(skillName: string | undefined, packages: string[], signal?: AbortSignal) {
    const invalid = validatePackages(packages);
    if (invalid) return { success: false, error: invalid };
    const prepared = await this.prepare(skillName, signal);
    if (!prepared.success) return prepared;
    return this.withLock(skillName ?? GENERAL, async () => {
      const r = await this.run(
        ["pip", "install", "--python", this.pythonExe(skillName), "--only-binary", ":all:", "--index-url", this.options.indexUrl, ...packages],
        signal,
      );
      if (r.code !== 0) {
        const text = r.output;
        const kind = /No solution|conflict|unsatisfiable/i.test(text)
          ? "依赖冲突"
          : /no wheels|only-binary|source distribution/i.test(text)
            ? "没有兼容的预编译 wheel"
            : /timed out|connect|network|dns/i.test(text)
              ? "网络错误"
              : "安装失败";
        return { success: false, error: `${kind}：${this.options.redactor.text(text.slice(-1200))}` };
      }
      return { success: true, packages, python: this.pythonExe(skillName) };
    });
  }
}

export function createPythonTools(manager: PythonManager) {
  const python_runtime_status = createTool({
    id: "python_runtime_status",
    description: "查看（或准备）某个 Skill 的独立 Python 3.13 环境。不传 skillName 时为通用环境。prepare=true 会创建空环境。",
    inputSchema: z.object({ skillName: z.string().min(1).max(64).optional(), prepare: z.boolean().default(false) }),
    execute: async ({ skillName, prepare }, context) => {
      try {
        if (prepare) return await manager.prepare(skillName, context?.abortSignal);
        return { success: true, ...manager.status(skillName) };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  });

  const python_install_packages = createTool({
    id: "python_install_packages",
    description:
      "为某个 Skill 的独立 Python 环境安装第三方包（只装预编译 wheel，从固定镜像源）。一次列出所有已知依赖，使用发行包名（如 Pillow 而不是 PIL）。请求批准模式下需要用户同意。",
    inputSchema: z.object({
      skillName: z.string().min(1).max(64).optional(),
      packages: z.array(z.string().min(1).max(200)).min(1).max(50),
      reason: z.string().max(500).describe("为什么需要这些包"),
    }),
    execute: async ({ skillName, packages }, context) => {
      try {
        return await manager.install(skillName, packages, context?.abortSignal);
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  });

  return { python_runtime_status, python_install_packages };
}
