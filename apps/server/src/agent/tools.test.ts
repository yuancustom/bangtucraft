import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redactor } from "../redact.ts";
import { resolveWorkspacePath } from "./paths.ts";
import { checkPresentFiles } from "./tools/interaction.ts";
import { createLocalCommandTool, runPowerShell, commandEnvironment } from "./tools/local-command.ts";
import { createLocalFileTools } from "./tools/local-files.ts";
import { validatePackages, PythonManager } from "./tools/python.ts";
import { discoverSkills } from "./skills.ts";
import { toHistory } from "./history.ts";

let root: string;
let ws: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tools-test-"));
  ws = path.join(root, "ws");
  fs.mkdirSync(ws, { recursive: true });
});
afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows 句柄 */
  }
});

describe("工作空间路径", () => {
  it("拒绝 .. 越界与工作空间外绝对路径", async () => {
    await expect(resolveWorkspacePath(ws, "../x.txt")).rejects.toThrow("工作空间外");
    await expect(resolveWorkspacePath(ws, path.join(root, "x.txt"))).rejects.toThrow("工作空间外");
    expect(await resolveWorkspacePath(ws, "a/b/new.txt")).toBe(path.join(ws, "a", "b", "new.txt"));
  });

  it("拒绝经 junction 逃逸（包括其下尚不存在的新文件）", async () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(ws, "link"), "junction");
    await expect(resolveWorkspacePath(ws, "link/secret.txt")).rejects.toThrow("符号链接");
    await expect(resolveWorkspacePath(ws, "link/deep/new.txt")).rejects.toThrow("符号链接");
  });
});

describe("present_files", () => {
  it("只接受工作空间内真实存在的文件，去重并给出类型", async () => {
    fs.writeFileSync(path.join(ws, "r.html"), "<p>x</p>");
    const r = await checkPresentFiles(ws, ["r.html", "./r.html", "missing.pdf", "../escape.txt"]);
    expect(r.success).toBe(false);
    expect(r.files).toEqual([{ path: "r.html", name: "r.html", size: 8, mediaType: "text/html" }]);
    expect(r.errors.map((e) => e.path)).toEqual(["missing.pdf", "../escape.txt"]);
  });
});

describe("local_command_execute", () => {
  const tool = () =>
    createLocalCommandTool({
      workspaceRoot: ws,
      redactor: new Redactor(["super-secret-value-123"]),
      extraEnv: () => ({ GCMP_DWG_TOOLS: "C:\\tools\\gcmp.exe" }),
      skillPythonEnv: async () => undefined,
    });

  it("在工作空间内执行，注入环境变量、中文输出正常、密钥脱敏", async () => {
    const out = (await tool().execute!(
      { command: "Write-Output \"中文-$env:GCMP_DWG_TOOLS\"; Write-Output super-secret-value-123; (Get-Location).Path", timeoutMs: 30000 } as never,
      {} as never,
    )) as { success: boolean; stdout: string };
    expect(out.success).toBe(true);
    expect(out.stdout).toContain("中文-C:\\tools\\gcmp.exe");
    expect(out.stdout).not.toContain("super-secret-value-123");
    expect(out.stdout).toContain(fs.realpathSync(ws));
  }, 30_000);

  it("cwd 越界被拒；pip 安装被引导到专用工具；Skill 未准备环境时拒绝", async () => {
    expect(await tool().execute!({ command: "dir", cwd: "..", timeoutMs: 5000 } as never, {} as never)).toMatchObject({ success: false });
    expect(await tool().execute!({ command: "pip install requests", timeoutMs: 5000 } as never, {} as never)).toMatchObject({ success: false });
    expect(await tool().execute!({ command: "python -V", skillName: "dwg-to-dxf", timeoutMs: 5000 } as never, {} as never)).toMatchObject({
      success: false,
    });
  });

  it("超时会终止整个进程树", async () => {
    const r = await runPowerShell("Start-Sleep -Seconds 30", { cwd: ws, env: commandEnvironment(), timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(r.executionTimeMs).toBeLessThan(15_000);
  }, 30_000);

  it("非零退出码视为失败", async () => {
    const r = await runPowerShell("cmd /c exit 3", { cwd: ws, env: commandEnvironment(), timeoutMs: 15000 });
    expect(r).toMatchObject({ success: false, exitCode: 3 });
  }, 30_000);

  it("环境变量走白名单，不继承任意变量", () => {
    process.env.SHOULD_NOT_LEAK_KEY = "x";
    expect(commandEnvironment().SHOULD_NOT_LEAK_KEY).toBeUndefined();
    delete process.env.SHOULD_NOT_LEAK_KEY;
  });
});

describe("工作空间外只读工具", () => {
  it("可读外部文件，工作空间内路径被拒并指引原生工具", async () => {
    const outside = path.join(root, "out.txt");
    fs.writeFileSync(outside, "第一行\n第二行\n第三行");
    fs.writeFileSync(path.join(ws, "in.txt"), "x");
    const tools = createLocalFileTools(ws);
    expect(await tools.local_file_read.execute!({ path: outside, offset: 1, limit: 1 } as never, {} as never)).toMatchObject({
      success: true,
      content: "第二行",
      totalLines: 3,
    });
    expect(await tools.local_file_read.execute!({ path: path.join(ws, "in.txt") } as never, {} as never)).toMatchObject({ success: false });
    expect(await tools.local_file_read.execute!({ path: "relative.txt" } as never, {} as never)).toMatchObject({ success: false });
    const list = (await tools.local_directory_list.execute!({ path: root } as never, {} as never)) as { items: { name: string }[] };
    expect(list.items.map((i) => i.name)).toContain("out.txt");
  });
});

describe("Python 依赖校验", () => {
  it("拒绝导入名、URL 与路径", () => {
    expect(validatePackages(["Pillow>=10", "ezdxf==1.4.4", "numpy"])).toBeUndefined();
    expect(validatePackages(["PIL"])).toContain("Pillow");
    expect(validatePackages(["cv2"])).toContain("opencv-python");
    expect(validatePackages(["git+https://x/y.git"])).toContain("不合法");
    expect(validatePackages(["./local.whl"])).toContain("不合法");
  });

  it("按 Skill 隔离环境目录，拒绝非法 skillName", () => {
    const m = new PythonManager({ uvExe: "uv", root, indexUrl: "https://x/simple", redactor: new Redactor() });
    expect(m.envDir("dwg-to-dxf")).not.toBe(m.envDir("dxf-frame-splitter"));
    expect(m.envDir()).toContain("_general");
    expect(() => m.envDir("../evil")).toThrow();
    expect(m.status("dwg-to-dxf").ready).toBe(false);
  });
});

describe("Skill 发现", () => {
  const skill = (dir: string, name: string, description: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n正文`);
  };

  it("合并 own / local / vendor，同名去重，非法 Skill 记入 problems，读取难度标注", () => {
    skill(path.join(root, "skills", "own", "alpha"), "alpha", "自研技能");
    const ext = path.join(root, "ext", "beta");
    skill(ext, "beta", "本地技能");
    fs.writeFileSync(path.join(root, "skills", "local.json"), JSON.stringify({ skills: [{ path: ext }, { path: path.join(root, "nope") }] }));
    skill(path.join(root, "skills", "vendor-bangtu", "alpha"), "alpha", "重名");
    skill(path.join(root, "skills", "vendor-bangtu", "too-long"), "too-long", "长".repeat(1100));
    skill(path.join(root, "skills", "vendor-bangtu", "wrongdir"), "other-name", "名字和目录不一致");
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(path.join(root, "config", "skill-tiers.json"), JSON.stringify({ tiers: { beta: "L1" } }));
    const cat = discoverSkills(root);
    expect(cat.skills.map((s) => `${s.source}:${s.name}`)).toEqual(["own:alpha", "local:beta"]);
    expect(cat.skills[1]!.tier).toBe("L1");
    expect(cat.problems).toHaveLength(4);
  });
});

describe("历史消息转换", () => {
  it("合并助手消息、提取工具结果与文件卡片", () => {
    const h = toHistory([
      { id: "1", role: "user", createdAt: "2026-01-01T00:00:00Z", content: { parts: [{ type: "text", text: "做报告" }] } },
      {
        id: "2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:01Z",
        content: {
          parts: [
            { type: "reasoning", reasoning: "想一想" },
            {
              type: "tool-invocation",
              toolInvocation: {
                toolCallId: "c1",
                toolName: "present_files",
                args: { paths: ["a.html"] },
                state: "result",
                result: { success: true, files: [{ path: "a.html", name: "a.html", size: 1, mediaType: "text/html" }] },
              },
            },
          ],
        },
      },
      { id: "3", role: "assistant", createdAt: "2026-01-01T00:00:02Z", content: { parts: [{ type: "text", text: "完成" }] } },
    ]);
    expect(h).toHaveLength(2);
    expect(h[1]!.parts.map((p) => p.type)).toEqual(["reasoning", "tool", "files", "text"]);
  });
});

it("PowerShell 可用", () => {
  expect(execSync("powershell -NoProfile -Command \"Write-Output ok\"").toString().trim()).toBe("ok");
});
