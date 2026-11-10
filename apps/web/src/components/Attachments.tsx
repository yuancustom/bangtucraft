import type { UploadAttachment } from "../use-uploads.ts";

export function Attachments({ files, remove }: { files: UploadAttachment[]; remove: (path: string) => void }) {
  return files.length ? <div className="chips">
    {files.map((f) => <span key={f.path} className="chip" title={f.path}>
      {f.image ? "🖼" : "📎"} {f.name}
      <button type="button" aria-label={`移除附件 ${f.name}`} onClick={() => remove(f.path)}>×</button>
    </span>)}
  </div> : null;
}
