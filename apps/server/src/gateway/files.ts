import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { mediaTypeOf, resolveWorkspacePath } from "../agent/paths.ts";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function workspaceOf(dataDir: string, userId: string) {
  return path.join(dataDir, "users", userId, "workspace");
}

export async function resolveUserFile(dataDir: string, userId: string, rel: string) {
  const abs = await resolveWorkspacePath(workspaceOf(dataDir, userId), rel);
  const info = await fs.stat(abs).catch(() => undefined);
  if (!info?.isFile()) throw new Error("文件不存在");
  return { abs, size: info.size, mediaType: mediaTypeOf(abs), name: path.basename(abs) };
}

/** 把 xlsx / docx / csv 转成只读 HTML 片段，供前端预览。 */
export async function previewHtml(abs: string): Promise<string> {
  const ext = path.extname(abs).toLowerCase();
  if (ext === ".docx") {
    const r = await mammoth.convertToHtml({ path: abs });
    return r.value;
  }
  if (ext === ".xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(abs);
    const parts: string[] = [];
    wb.worksheets.slice(0, 10).forEach((ws) => {
      const rows: string[] = [];
      let count = 0;
      ws.eachRow({ includeEmpty: false }, (row) => {
        if (count++ >= 1000) return;
        const cells = (row.values as unknown[]).slice(1).map((v) => {
          const value =
            v && typeof v === "object" ? ((v as { result?: unknown; text?: unknown }).result ?? (v as { text?: unknown }).text ?? JSON.stringify(v)) : v;
          return `<td>${escapeHtml(value === undefined || value === null ? "" : String(value))}</td>`;
        });
        rows.push(`<tr>${cells.join("")}</tr>`);
      });
      parts.push(`<h3>${escapeHtml(ws.name)}</h3><table>${rows.join("")}</table>${count > 1000 ? "<p>（仅显示前 1000 行）</p>" : ""}`);
    });
    return parts.join("");
  }
  if (ext === ".csv") {
    const text = (await fs.readFile(abs, "utf8")).split(/\r?\n/).slice(0, 1000);
    return `<table>${text.map((line) => `<tr>${line.split(",").map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</table>`;
  }
  throw new Error("该格式不支持转换预览");
}

export async function saveUpload(dataDir: string, userId: string, file: File): Promise<{ path: string; size: number }> {
  if (file.size > 100 * 1024 * 1024) throw new Error("文件超过 100MiB");
  const safe = path.basename(file.name).replace(/[<>:"/\\|?*]/g, "_").replace(/\p{Cc}/gu, "_").slice(0, 180) || "upload.bin";
  const root = workspaceOf(dataDir, userId);
  const dir = path.join(root, "uploads");
  await fs.mkdir(dir, { recursive: true });
  let target = path.join(dir, safe);
  for (let i = 1; await fs.stat(target).then(() => true, () => false); i++) {
    const ext = path.extname(safe);
    target = path.join(dir, `${path.basename(safe, ext)}(${i})${ext}`);
  }
  await fs.writeFile(target, Buffer.from(await file.arrayBuffer()));
  return { path: path.relative(root, target).split(path.sep).join("/"), size: file.size };
}
