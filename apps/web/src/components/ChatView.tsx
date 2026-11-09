import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryMessage, ModelInfo, PermissionMode, SkillInfo } from "@drawing-agent/shared";
import { api } from "../api.ts";
import { STATUS_LABEL, type Block, type RunView } from "../run-state.ts";
import { trackRun, useRuns } from "../runs-store.ts";
import { Blocks } from "./Blocks.tsx";

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
  const [history, setHistory] = useState<HistoryMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [model, setModel] = useState(() => localStorage.getItem("model") ?? "auto");
  const [mode, setMode] = useState<PermissionMode>(() => (localStorage.getItem("mode") as PermissionMode) ?? "request");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const allRuns = useRuns();
  const runs = useMemo(() => allRuns.filter((r) => r.threadId === threadId), [allRuns, threadId]);
  const active = runs.find((r) => !r.finished);
  const bottom = useRef<HTMLDivElement>(null);
  const loadedAt = useRef(0);

  useEffect(() => {
    setLoading(true);
    setError("");
    loadedAt.current = Date.now();
    api
      .history(threadId)
      .then((r) => setHistory(r.messages), (e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [threadId]);

  useEffect(() => localStorage.setItem("model", model), [model]);
  useEffect(() => localStorage.setItem("mode", mode), [mode]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [runs, history.length]);

  // 历史里已经包含的轮次，不再重复显示实时面板；仍在运行的轮次从历史里剔除其后的消息。
  const visibleRuns = runs.filter((r) => !r.finished || r.startedAt >= loadedAt.current);
  const cutoff = Math.min(...visibleRuns.map((r) => r.startedAt), Infinity);
  const visibleHistory = history.filter((m) => new Date(m.createdAt).getTime() < cutoff - 1000);

  const slash = /^\/(\S*)$/.exec(text);
  const skillMatches = slash ? skills.filter((s) => s.name.includes(slash[1]!) || s.description.includes(slash[1]!)).slice(0, 12) : [];

  const send = async () => {
    const body = text.trim();
    if (!body || active || sending) return;
    setSending(true);
    setError("");
    try {
      const { runId } = await api.send(threadId, { text: body, model, permissionMode: mode, skills: selectedSkills, images });
      trackRun(runId, threadId, body);
      setText("");
      setSelectedSkills([]);
      setImages([]);
      onActivity();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const upload = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      try {
        const r = await api.upload(f);
        if (f.type.startsWith("image/")) setImages((x) => [...x, r.path]);
        else setText((t) => `${t}${t ? "\n" : ""}[附件] ${r.path}`);
      } catch (e) {
        setError((e as Error).message);
      }
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
        {(selectedSkills.length > 0 || images.length > 0) && (
          <div className="chips">
            {selectedSkills.map((s) => (
              <span key={s} className="chip">
                /{s} <button onClick={() => setSelectedSkills((x) => x.filter((y) => y !== s))}>×</button>
              </span>
            ))}
            {images.map((p) => (
              <span key={p} className="chip">
                🖼 {p.split("/").pop()} <button onClick={() => setImages((x) => x.filter((y) => y !== p))}>×</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          value={text}
          placeholder={active ? "本会话正在运行，可以先编辑下一条…" : "输入消息，Enter 发送，Shift+Enter 换行，/ 选择技能"}
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
            <option value="request">请求批准</option>
            <option value="full-access">完全访问</option>
          </select>
          <label className="upload">
            上传
            <input type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
          </label>
          <span className="spacer" />
          {error && <span className="error-text">{error}</span>}
          {active ? (
            <button className="danger" onClick={() => void api.abort(active.runId)}>
              停止
            </button>
          ) : (
            <button className="primary" disabled={!text.trim() || sending} onClick={() => void send()}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
