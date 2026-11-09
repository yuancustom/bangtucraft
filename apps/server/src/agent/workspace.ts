import fs from "node:fs/promises";
import path from "node:path";
import { LocalFilesystem, Workspace, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { resolveWorkspacePath } from "./paths.ts";

const MAX_TEXT_BYTES = 1024 * 1024;
const FS = WORKSPACE_TOOLS.FILESYSTEM;

/** 用户工作空间：Mastra 原生 8 个文件工具，contained，额外校验 junction 逃逸和大小。 */
export function createUserWorkspace(root: string) {
  const filesystem = new LocalFilesystem({ basePath: root, contained: true });
  return new Workspace({
    id: "user-workspace",
    name: "用户工作空间",
    filesystem,
    tools: {
      enabled: false,
      hooks: {
        beforeToolCall: async ({ workspaceToolName, input }: { workspaceToolName: string; input: unknown }) => {
          const value = (input ?? {}) as Record<string, unknown>;
          const target = await resolveWorkspacePath(root, String(value.path ?? "."));
          if (workspaceToolName === FS.DELETE && !path.relative(path.resolve(root), target)) {
            throw new Error("不能删除工作空间根目录。");
          }
          if (workspaceToolName === FS.READ_FILE || workspaceToolName === FS.EDIT_FILE) {
            const info = await fs.stat(target).catch(() => undefined);
            if (info?.isFile() && info.size > MAX_TEXT_BYTES) {
              throw new Error("单次文本读取/编辑限制为 1MiB，请用命令分段处理。");
            }
          }
          for (const text of [value.content, value.old_string, value.new_string]) {
            if (typeof text === "string" && Buffer.byteLength(text) > MAX_TEXT_BYTES) {
              throw new Error("单次文本写入/编辑限制为 1MiB。");
            }
          }
        },
      },
      [FS.READ_FILE]: { enabled: true, mediaTypes: false },
      [FS.WRITE_FILE]: { enabled: true, requireReadBeforeWrite: true },
      [FS.EDIT_FILE]: { enabled: true, requireReadBeforeWrite: true },
      [FS.LIST_FILES]: { enabled: true },
      [FS.FILE_STAT]: { enabled: true },
      [FS.MKDIR]: { enabled: true },
      [FS.GREP]: { enabled: true },
      [FS.DELETE]: { enabled: true },
    },
    autoSync: false,
  } as ConstructorParameters<typeof Workspace>[0]);
}

export const WORKSPACE_TOOL_NAMES = [
  FS.READ_FILE,
  FS.WRITE_FILE,
  FS.EDIT_FILE,
  FS.LIST_FILES,
  FS.FILE_STAT,
  FS.MKDIR,
  FS.GREP,
  FS.DELETE,
] as string[];
