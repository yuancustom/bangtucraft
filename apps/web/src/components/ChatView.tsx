import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryMessage, ModelInfo, PermissionMode, SkillInfo } from "@drawing-agent/shared";
import { DEFAULT_PERMISSION_MODE } from "@drawing-agent/shared";
import { api } from "../api.ts";
import { attachmentText, useUploads } from "../use-uploads.ts";
import { STATUS_LABEL, type Block, type RunView } from "../run-state.ts";
import { trackRun, useRuns } from "../runs-store.ts";
import { Blocks } from "./Blocks.tsx";
import { Attachments } from "./Attachments.tsx";

function historyBlocks(m: HistoryMessage): Block[] {
  return m.parts.map((p): Block => {
    switch (p.type) {
      case "text":
        return { kind: "text", text: p.text };
      case "reasoning":
        return { kind: "reasoning", text: p.text };
      case "tool":
        return { kind: "tool", toolCallId: p.toolCallId, toolName: p.toolName, args: p.args, result: p.result, isError: p.isError };
      case "files":
        return { kind: "files", files: p.files };
    }
  });
}

function RunPanel({ run }: { run: RunView }) {
  const waiting = run.status === "waiting_plan";
  return (
    <div className="msg assistant">
      <div className="run-meta">
        {run.route && (
          <span className="badge" title={run.route.reasons.join("\n")}>
            {run.route.complexity} → {run.route.tier}
          </span>
        )}
        {run.models.map((m, i) => (
          <span key={i} className={`badge tier-${m.tier}`}>
            {m.phase === "plan" ? "规划" : "执行"}：{m.modelId}
          </span>
        ))}
        <span className={`status status-${run.status}`}>{STATUS_LABEL[run.status]}</span>
        {run.reconnecting && !run.finished && <span className="muted" role="status">连接中断，正在自动重连；后台任务继续运行</span>}
        {!run.finished && (
          <button className="link danger" onClick={() => void api.abort(run.runId)}>
            停止
          </button>
        )}
      </div>
      <Blocks blocks={run.blocks} runId={run.runId} live={!run.finished} waitingPlan={waiting} />
      {run.usage && (
        <div className="usage">
          输入 {run.usage.inputTokens.toLocaleString()} / 输出 {run.usage.outputTokens.toLocaleString()} tokens · 估算 {run.usage.costEstimate.toFixed(4)}{" "}
          {run.usage.currency}
        </div>
      )}
    </div>
  );
}

export function ChatView({
  threadId,
  models,
  skills,
  onActivity,
}: {
  threadId: string;
  models: ModelInfo[];
  skills: SkillInfo[];
  onActivity: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{ threadId: string; messages: HistoryMessage[]; completedRuns: string[] }>({ threadId, messages: [], completedRuns: [] });
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [model, setModel] = useState(() => localStorage.getItem("model") ?? "auto");
  const [mode, setMode] = useState<PermissionMode>(() => localStorage.getItem("permission-mode-v2") === "request" ? "request" : DEFAULT_PERMISSION_MODE);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [error, setError] = useState("");
  const uploads = useUploads(setError);
  const [sending, setSending] = useState(false);
  const allRuns = useRuns();
  const runs = useMemo(() => allRuns.filter((r) => r.threadId === threadId), [allRuns, threadId]);
  const active = runs.find((r) => !r.finished);
  const question = active?.status === "waiting_input"
    ? active.blocks.findLast((b): b is Extract<Block, { kind: "question" }> => b.kind === "question" && !b.resolved)
    : undefined;
  const bottom = useRef<HTMLDivElement>(null);
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const history = snapshot.threadId === threadId ? snapshot.messages : [];

  useEffect(() => {
    setLoading(true);
    setError("");
    let cancelled = false;
    // 只隐藏此次请求之前已结束的轮次。请求期间结束的轮次继续展示完整实时面板。
    const completedRuns = runsRef.current.filter((r) => r.threadId === threadId && r.finished).map((r) => r.runId);
    api
      .history(threadId)
      .then((r) => { if (!cancelled) setSnapshot({ threadId, messages: r.messages, completedRuns }); }, (e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [threadId]);

  useEffect(() => localStorage.setItem("model", model), [model]);
  useEffect(() => localStorage.setItem("permission-mode-v2", mode), [mode]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [runs, history.length]);

  // 刷新恢复的轮次即使开始于历史加载之前，结束后也保留回复和文件，直到下次加载历史。
  const visibleRuns = runs.filter((r) => snapshot.threadId !== threadId || !snapshot.completedRuns.includes(r.runId));
  const cutoff = Math.min(...visibleRuns.map((r) => r.startedAt), Infinity);
  const visibleHistory = history.filter((m) => new Date(m.createdAt).getTime() < cutoff - 1000);

  const slash = /^\/(\S*)$/.exec(text);
  const skillMatches = slash ? skills.filter((s) => s.name.includes(slash[1]!) || s.description.includes(slash[1]!)).slice(0, 12) : [];

  const send = async () => {
    const body = attachmentText(text, uploads.files);
    if (!body || (active && !question) || sending || uploads.isUploading()) return;
    setSending(true);
    setError("");
    try {
      if (active && question) {
        await api.answer(active.runId, question.toolCallId, [], body);
      } else {
        const { runId } = await api.send(threadId, { text: body, model, permissionMode: mode, skills: selectedSkills, images: uploads.files.filter((f) => f.image).map((f) => f.path) });
        trackRun(runId, threadId, body);
      }
      setText("");
      setSelectedSkills([]);
      uploads.clear();
      onActivity();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat">
      <div className="messages">
        {loading && <div className="muted center">加载中…</div>}
        {!loading && !visibleHistory.length && !visibleRuns.length && <div className="empty">有什么可以帮你？可以输入 / 选择技能。</div>}
        {visibleHistory.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === "user" ? <div className="user-text">{m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</div> : <Blocks blocks={historyBlocks(m)} />}
          </div>
        ))}
        {visibleRuns.map((r) => (
          <div key={r.runId}>
            <div className="msg user">
              <div className="user-text">{r.prompt}</div>
            </div>
            <RunPanel run={r} />
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="composer">
        {skillMatches.length > 0 && (
          <div className="skill-menu">
            {skillMatches.map((s) => (
              <button
                key={s.name}
                onClick={() => {
                  setSelectedSkills((x) => (x.includes(s.name) ? x : [...x, s.name]));
                  setText("");
                }}
              >
                <b>{s.name}</b>
                <span className="muted">
                  {s.tier ? `[${s.tier}] ` : ""}
                  {s.description.slice(0, 80)}
                </span>
              </button>
            ))}
          </div>
        )}
        {selectedSkills.length > 0 && (
          <div className="chips">
            {selectedSkills.map((s) => (
              <span key={s} className="chip">
                /{s} <button onClick={() => setSelectedSkills((x) => x.filter((y) => y !== s))}>×</button>
              </span>
            ))}
          </div>
        )}
        <Attachments files={uploads.files} remove={uploads.remove} />
        {uploads.uploading && <div className="muted" role="status">上传中，请稍候…</div>}
        {question && <div className="muted">可以在这里上传文件并点击“补充并继续”，或使用上方的问题卡片。</div>}
        <textarea
          value={text}
          placeholder={question ? "补充说明或上传文件，继续当前任务…" : active ? "本会话正在运行，可以先编辑下一条…" : "输入消息，Enter 发送，Shift+Enter 换行，/ 选择技能"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
        />
        <div className="composer-bar">
          <select value={model} onChange={(e) => setModel(e.target.value)} title="模型">
            <option value="auto">自动选择模型</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.tier} · {m.name}
              </option>
            ))}
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)} title="权限模式">
            <option value="full-access">本地自动执行（付费仍确认）</option>
            <option value="request">本地操作请求批准</option>
          </select>
          <label className="upload">
            上传
            <input type="file" aria-label="上传附件" multiple hidden disabled={uploads.uploading || sending} onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = "";
              void uploads.upload(files);
            }} />
          </label>
          <span className="spacer" />
          {error && <span className="error-text">{error}</span>}
          {active && !question ? (
            <button className="danger" onClick={() => void api.abort(active.runId)}>
              停止
            </button>
          ) : <>
            {active && <button className="danger" onClick={() => void api.abort(active.runId)}>停止</button>}
            <button className="primary" disabled={(!text.trim() && !uploads.files.length) || sending || uploads.uploading} onClick={() => void send()}>
              {question ? "补充并继续" : "发送"}
            </button>
          </>}
        </div>
      </div>
    </div>
  );
}
