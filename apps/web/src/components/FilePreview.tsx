import { useEffect, useState } from "react";
import type { FileCard } from "@drawing-agent/shared";
import { api, fileUrl } from "../api.ts";

const CONVERTED = /\.(xlsx|docx|csv)$/i;
const TEXT = /^(text\/(plain|markdown)|application\/json)/;

export function FilePreview({ file, onClose }: { file: FileCard; onClose: () => void }) {
  const [html, setHtml] = useState<string>();
  const [text, setText] = useState<string>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (CONVERTED.test(file.name)) {
      api.preview(file.path).then((r) => setHtml(r.html), (e: Error) => setError(e.message));
    } else if (TEXT.test(file.mediaType)) {
      fetch(fileUrl(file.path))
        .then((r) => r.text())
        .then((t) => setText(t.slice(0, 500_000)), (e: Error) => setError(e.message));
    }
  }, [file]);

  let body: React.ReactNode;
  if (error) body = <div className="error-text">{error}</div>;
  else if (/html|svg/.test(file.mediaType) || file.mediaType === "application/pdf")
    // HTML 成果在沙箱 iframe 中运行（服务端同时下发 CSP sandbox），无法访问本站 Cookie。
    body = <iframe title={file.name} src={fileUrl(file.path)} sandbox={file.mediaType === "application/pdf" ? undefined : "allow-scripts"} />;
  else if (file.mediaType.startsWith("image/")) body = <img src={fileUrl(file.path)} alt={file.name} />;
  else if (CONVERTED.test(file.name))
    body = html === undefined ? <div className="muted">转换中…</div> : <iframe title={file.name} sandbox="" srcDoc={`<style>body{font:13px system-ui}table{border-collapse:collapse}td{border:1px solid #ccc;padding:2px 6px}</style>${html}`} />;
  else if (TEXT.test(file.mediaType)) body = <pre className="text-preview">{text ?? "加载中…"}</pre>;
  else body = <div className="muted">该格式不支持在线预览，请下载查看。</div>;

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{file.name}</b>
          <span className="muted">{file.path}</span>
          <span className="spacer" />
          <a href={fileUrl(file.path, true)}>下载</a>
          <button onClick={onClose}>关闭</button>
        </div>
        <div className="modal-content">{body}</div>
      </div>
    </div>
  );
}
