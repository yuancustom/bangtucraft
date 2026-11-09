import fs from "node:fs/promises";
import path from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { FileCard } from "@drawing-agent/shared";
import { mediaTypeOf, resolveWorkspacePath } from "../paths.ts";

const MAX_FILE = 100 * 1024 * 1024;

const optionSchema = z.object({ id: z.string().min(1), label: z.string().min(1), description: z.string().optional() });
const askPayload = z.object({
  question: z.string().min(1).describe("要问用户的问题"),
  options: z.array(optionSchema).optional().describe("可选项；不给则只接受自由输入"),
  allowMultiple: z.boolean().optional().describe("是否允许多选"),
  allowFreeText: z.boolean().optional().describe("是否允许自由输入（默认允许）"),
});
const resumeSchema = z.object({ selectedIds: z.array(z.string()).optional(), text: z.string().optional() });

export const askUserTool = createTool({
  id: "ask_user",
  description:
    "缺少必要信息、或需要用户在多个方案间选择时调用：挂起本轮并向用户提问，用户回答后自动继续。不要用它确认普通操作，能自行判断时不要调用。",
  inputSchema: askPayload,
  suspendSchema: askPayload,
  resumeSchema,
  execute: async (input, context) => {
    const agent = (context as { agent?: { resumeData?: z.infer<typeof resumeSchema>; suspend?: (p: unknown) => Promise<void> } })?.agent;
    const resumeData = agent?.resumeData;
    if (resumeData) {
      return { answered: true, selectedIds: resumeData.selectedIds ?? [], text: resumeData.text ?? "" };
    }
    if (!agent?.suspend) return { answered: false, note: "当前环境不支持挂起提问，请直接在回复中向用户提问。" };
    await agent.suspend({
      question: input.question,
      options: input.options,
      allowMultiple: input.allowMultiple ?? false,
      allowFreeText: input.allowFreeText ?? true,
    });
    return { answered: false };
  },
});

export async function checkPresentFiles(workspaceRoot: string, paths: string[]) {
  const files: FileCard[] = [];
  const errors: { path: string; error: string }[] = [];
  const root = path.resolve(workspaceRoot);
  const seen = new Set<string>();
  for (const p of paths) {
    try {
      const abs = await resolveWorkspacePath(workspaceRoot, p);
      const info = await fs.stat(abs).catch(() => undefined);
      if (!info) throw new Error("文件不存在");
      if (!info.isFile()) throw new Error("不是文件");
      if (info.size > MAX_FILE) throw new Error("文件超过 100MiB");
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (seen.has(rel)) continue;
      seen.add(rel);
      files.push({ path: rel, name: path.basename(abs), size: info.size, mediaType: mediaTypeOf(abs) });
    } catch (error) {
      errors.push({ path: p, error: (error as Error).message });
    }
  }
  return { success: errors.length === 0, files, errors };
}

export function createPresentFilesTool(workspaceRoot: string) {
  return createTool({
    id: "present_files",
    description:
      "把已生成并确认存在的成果文件展示为聊天文件卡片，供用户预览和下载。只接受工作空间内的文件（相对路径或工作空间内绝对路径），最多 100 个，单个不超过 100MiB。不生成、不复制文件。",
    inputSchema: z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(100) }),
    execute: async ({ paths }) => checkPresentFiles(workspaceRoot, paths),
  });
}
