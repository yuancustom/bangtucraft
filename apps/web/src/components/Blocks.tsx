import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FileCard } from "@drawing-agent/shared";
import { api, fileUrl } from "../api.ts";
import { attachmentText, useUploads } from "../use-uploads.ts";
import type { Block } from "../run-state.ts";
import { FilePreview } from "./FilePreview.tsx";
import { Attachments } from "./Attachments.tsx";

const TOOL_LABEL: Record<string, string> = {
  local_command_execute: "执行命令",
  present_files: "交付文件",
  ask_user: "询问用户",
  skill: "加载技能",
  skill_read: "读取技能资料",
  skill_search: "搜索技能资料",
  python_install_packages: "安装 Python 依赖",
  python_runtime_status: "Python 环境",
  local_file_read: "读取外部文件",
  local_file_stat: "查看外部文件",
  local_directory_list: "浏览外部目录",
  search_web: "联网搜索",
  fetch_url: "读取网页",
  mastra_workspace_read_file: "读取文件",
  mastra_workspace_write_file: "写入文件",
  mastra_workspace_edit_file: "编辑文件",
  mastra_workspace_list_files: "列出文件",
  mastra_workspace_delete: "删除文件",
  mastra_workspace_file_stat: "查看文件",
  mastra_workspace_mkdir: "新建目录",
  mastra_workspace_grep: "搜索文件内容",
};

export const toolLabel = (name: string) => TOOL_LABEL[name] ?? name;

function summarizeArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = a.command ?? a.path ?? a.name ?? a.skillName ?? a.query ?? a.url ?? (Array.isArray(a.paths) ? a.paths.join("、") : undefined);
  if (toolName === "python_install_packages" && Array.isArray(a.packages)) return (a.packages as string[]).join(" ");
  return typeof pick === "string" ? pick : "";
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer noopener" /> }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning">
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {live ? "思考中…" : "思考过程"}（{text.length} 字）
      </button>
      {open && <pre>{text}</pre>}
    </div>
  );
}

function ToolCard({ b }: { b: Extract<Block, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const pending = b.result === undefined;
  return (
    <div className={`tool ${b.isError ? "error" : ""}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-state">{pending ? "⏳" : b.isError ? "✗" : "✓"}</span>
        <span className="tool-name">{toolLabel(b.toolName)}</span>
        <span className="tool-arg">{summarizeArgs(b.toolName, b.args)}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="caption">{b.toolName} 参数</div>
          <pre>{JSON.stringify(b.args, null, 2)}</pre>
          {!pending && (
            <>
              <div className="caption">结果</div>
              <pre>{typeof b.result === "string" ? b.result : JSON.stringify(b.result, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function FileCards({ files }: { files: FileCard[] }) {
  const [preview, setPreview] = useState<FileCard | null>(null);
  return (
    <div className="files">
      {files.map((f) => (
        <div className="file-card" key={f.path}>
          <div className="file-name" title={f.path}>
            📄 {f.name}
          </div>
          <div className="file-meta">
            {f.path} · {(f.size / 1024).toFixed(1)} KB
          </div>
          <div className="file-actions">
            <button onClick={() => setPreview(f)}>预览</button>
            <a href={fileUrl(f.path, true)}>下载</a>
          </div>
        </div>
      ))}
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function ApprovalCard({ b, runId }: { b: Extract<Block, { kind: "approval" }>; runId?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(b.resolved);
  const act = async (approved: boolean) => {
    if (!runId) return;
    setBusy(true);
    try {
      await api.approve(runId, b.toolCallId, approved, approved ? undefined : "用户拒绝了此操作");
      setDone(approved ? "approved" : "declined");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resolved = done ?? b.resolved;
  return (
    <div className="card approval">
      <div className="card-title">需要批准：{b.reason}</div>
      <pre>{summarizeArgs(b.toolName, b.args) || JSON.stringify(b.args, null, 2)}</pre>
      {resolved ? (
        <div className="muted">{resolved === "approved" ? "已批准" : "已拒绝"}</div>
      ) : (
        <div className="row">
          <button className="primary" disabled={busy || !runId} onClick={() => act(true)}>
            批准
          </button>
          <button disabled={busy || !runId} onClick={() => act(false)}>
            拒绝
          </button>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

function QuestionCard({ b, runId }: { b: Extract<Block, { kind: "question" }>; runId?: string }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(b.resolved);
  const [error, setError] = useState("");
  const uploads = useUploads(setError);
  const toggle = (id: string) =>
    setSelected((s) => (b.allowMultiple ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]));
  const submit = async () => {
    if (!runId || uploads.isUploading()) return;
    setBusy(true);
    try {
      await api.answer(runId, b.toolCallId, selected, attachmentText(text, uploads.files));
      setDone("已回答");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resolved = done ?? b.resolved;
  return (
    <div className="card question">
      <div className="card-title">{b.question}</div>
      {b.options?.map((o) => (
        <label key={o.id} className="option">
          <input type={b.allowMultiple ? "checkbox" : "radio"} checked={selected.includes(o.id)} disabled={Boolean(resolved)} onChange={() => toggle(o.id)} />
          <span>
            {o.label}
            {o.description && <span className="muted"> —— {o.description}</span>}
          </span>
        </label>
      ))}
      {b.allowFreeText && !resolved && <textarea placeholder="补充说明（可选）" value={text} onChange={(e) => setText(e.target.value)} rows={2} />}
      {!resolved && <>
        <Attachments files={uploads.files} remove={uploads.remove} />
        <label className="upload">{uploads.uploading ? "上传中…" : "上传补充文件"}
          <input type="file" aria-label="上传补充文件" multiple hidden disabled={busy || uploads.uploading || !runId} onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            void uploads.upload(files);
          }} />
        </label>
      </>}
      {resolved ? (
        <div className="muted">{resolved}</div>
      ) : (
        <div className="row">
          <button className="primary" disabled={busy || uploads.uploading || !runId || (!selected.length && !text.trim() && !uploads.files.length)} onClick={submit}>
            提交
          </button>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

function PlanCard({ b, runId, waiting }: { b: Extract<Block, { kind: "plan" }>; runId?: string; waiting: boolean }) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (action: "approve" | "reject" | "revise") => {
    if (!runId) return;
    setBusy(true);
    try {
      await api.plan(runId, action, feedback || undefined);
      setFeedback("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const p = b.plan;
  return (
    <div className="card plan">
      <div className="card-title">执行计划：{p.goal}</div>
      <ol>
        {p.steps.map((s, i) => (
          <li key={i}>
            <b>{s.title}</b>
            {s.detail && <span> —— {s.detail}</span>}
            {(s.tools?.length || s.skills?.length) && (
              <div className="muted">{[...(s.skills ?? []).map((x) => `技能 ${x}`), ...(s.tools ?? [])].join("、")}</div>
            )}
          </li>
        ))}
      </ol>
      {p.deliverables.length > 0 && <div>交付物：{p.deliverables.join("、")}</div>}
      {p.risks && p.risks.length > 0 && <div className="warn-text">注意：{p.risks.join("；")}</div>}
      <div className="muted">执行档位：{p.executorTier}</div>
      {waiting && (
        <>
          <textarea placeholder="修改意见（选填，用于“修改计划”）" value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} />
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => act("approve")}>
              确认执行
            </button>
            <button disabled={busy || !feedback.trim()} onClick={() => act("revise")}>
              修改计划
            </button>
            <button disabled={busy} onClick={() => act("reject")}>
              取消
            </button>
          </div>
        </>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

export function Blocks({ blocks, runId, live, waitingPlan }: { blocks: Block[]; runId?: string; live?: boolean; waitingPlan?: boolean }) {
  const lastPlan = blocks.map((b) => b.kind).lastIndexOf("plan");
  return (
    <>
      {blocks.map((b, i) => {
        const isLast = i === blocks.length - 1;
        switch (b.kind) {
          case "text":
            return <Markdown key={i} text={b.text} />;
          case "reasoning":
            return <Reasoning key={i} text={b.text} live={Boolean(live && isLast)} />;
          case "tool":
            return <ToolCard key={b.toolCallId || i} b={b} />;
          case "approval":
            return <ApprovalCard key={`a-${b.toolCallId}`} b={b} runId={live ? runId : undefined} />;
          case "question":
            return <QuestionCard key={`q-${b.toolCallId}`} b={b} runId={live ? runId : undefined} />;
          case "plan":
            return <PlanCard key={`p-${i}`} b={b} runId={runId} waiting={Boolean(waitingPlan && i === lastPlan)} />;
          case "files":
            return <FileCards key={`f-${i}`} files={b.files} />;
          case "note":
            return (
              <div key={i} className={`note ${b.tone}`}>
                {b.text}
              </div>
            );
        }
      })}
    </>
  );
}
