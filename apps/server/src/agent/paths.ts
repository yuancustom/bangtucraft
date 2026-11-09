import fs from "node:fs/promises";
import path from "node:path";

export const isInside = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return !rel || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * 解析工作空间内路径：拒绝越界、符号链接 / junction 逃逸（包括尚不存在的新文件的已有父目录）。
 * 返回绝对路径。
 */
export async function resolveWorkspacePath(root: string, input: string): Promise<string> {
  if (typeof input !== "string" || !input || input.includes("\0")) throw new Error("工作空间路径无效。");
  await fs.mkdir(root, { recursive: true });
  const canonicalRoot = await fs.realpath(root);
  const target = path.resolve(root, input);
  if (!isInside(path.resolve(root), target)) {
    throw new Error("此路径在工作空间外；外部文件请使用只读外部工具，并经用户批准。");
  }
  let ancestor = target;
  for (;;) {
    try {
      await fs.lstat(ancestor);
      const canonical = await fs.realpath(ancestor);
      if (!isInside(canonicalRoot, canonical)) throw new Error("路径经符号链接指向工作空间外，无法操作。");
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const entry = await fs.lstat(ancestor).catch(() => undefined);
      if (entry?.isSymbolicLink()) throw new Error("路径包含失效的符号链接。");
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error("工作空间路径不可访问。");
      ancestor = parent;
    }
  }
}

/** 解析工作空间外的绝对路径（只读工具用），返回真实路径。 */
export async function resolveExternalPath(input: string): Promise<string> {
  if (typeof input !== "string" || !input || input.includes("\0") || !path.isAbsolute(input)) {
    throw new Error("请提供绝对路径。");
  }
  return fs.realpath(input);
}

const MEDIA_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".dxf": "image/vnd.dxf",
  ".dwg": "image/vnd.dwg",
  ".zip": "application/zip",
  ".glb": "model/gltf-binary",
  ".ifc": "application/x-step",
};

export function mediaTypeOf(file: string): string {
  return MEDIA_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
