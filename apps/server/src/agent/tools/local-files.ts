import fs from "node:fs/promises";
import path from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { isInside, resolveExternalPath } from "../paths.ts";

const MAX_READ = 1024 * 1024;
const PAGE = 200;

/** 工作空间外只读工具：stat / 列目录 / 读文本。请求批准模式下每次调用都需用户批准。 */
export function createLocalFileTools(workspaceRoot: string) {
  const guard = async (input: string) => {
    const real = await resolveExternalPath(input);
    const root = await fs.realpath(workspaceRoot).catch(() => path.resolve(workspaceRoot));
    if (isInside(root, real)) throw new Error("该路径在工作空间内，请改用 mastra_workspace_* 文件工具。");
    return real;
  };

  const local_file_stat = createTool({
    id: "local_file_stat",
    description: "查看工作空间外某个文件或目录的基本信息（只读，需用户批准）。path 必须是绝对路径。",
    inputSchema: z.object({ path: z.string().min(1).max(4096) }),
    execute: async ({ path: p }) => {
      try {
        const real = await guard(p);
        const info = await fs.stat(real);
        return { success: true, path: real, type: info.isDirectory() ? "directory" : "file", size: info.size, modifiedAt: info.mtime.toISOString() };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  });

  const local_directory_list = createTool({
    id: "local_directory_list",
    description: `列出工作空间外某个目录的条目（只读，需用户批准），每页 ${PAGE} 条；返回 nextOffset 时继续翻页。`,
    inputSchema: z.object({ path: z.string().min(1).max(4096), offset: z.number().int().min(0).default(0) }),
    execute: async ({ path: p, offset }) => {
      try {
        const real = await guard(p);
        const entries = await fs.readdir(real, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const start = offset ?? 0;
        const page = entries.slice(start, start + PAGE);
        const items = await Promise.all(
          page.map(async (e) => {
            const full = path.join(real, e.name);
            const size = e.isFile() ? (await fs.stat(full).catch(() => undefined))?.size : undefined;
            return { name: e.name, type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : "file", size };
          }),
        );
        const next = start + PAGE < entries.length ? start + PAGE : undefined;
        return { success: true, path: real, total: entries.length, items, nextOffset: next };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  });

  const local_file_read = createTool({
    id: "local_file_read",
    description: "读取工作空间外的文本文件（只读，需用户批准），单次最多 1MiB；可按行 offset/limit 分段读取。",
    inputSchema: z.object({
      path: z.string().min(1).max(4096),
      offset: z.number().int().min(0).default(0).describe("起始行（0 开始）"),
      limit: z.number().int().min(1).max(5000).default(2000),
    }),
    execute: async ({ path: p, offset, limit }) => {
      try {
        const real = await guard(p);
        const info = await fs.stat(real);
        if (!info.isFile()) return { success: false, error: "不是文件。" };
        if (info.size > 20 * MAX_READ) return { success: false, error: "文件超过 20MiB，请用命令处理。" };
        const lines = (await fs.readFile(real, "utf8")).split(/\r?\n/);
        const start = offset ?? 0;
        let content = lines.slice(start, start + (limit ?? 2000)).join("\n");
        if (Buffer.byteLength(content) > MAX_READ) content = content.slice(0, MAX_READ / 3);
        return { success: true, path: real, totalLines: lines.length, offset: start, content };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  });

  return { local_file_stat, local_directory_list, local_file_read };
}
