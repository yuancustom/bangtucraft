import { useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "@drawing-agent/shared";
import { api, type CompareView } from "../api.ts";
import { STATUS_LABEL } from "../run-state.ts";
import { trackRun, useRuns } from "../runs-store.ts";
import { Blocks, Markdown } from "./Blocks.tsx";

interface Replica {
  label: string;
  model: string;
}

function CreateForm({ models, onCreated }: { models: ModelInfo[]; onCreated: (id: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [caseId, setCaseId] = useState("");
  const [cases, setCases] = useState<{ id: string; title: string; prompt: string }[]>([]);
  const [replicas, setReplicas] = useState<Replica[]>([
    { label: "自动路由", model: "auto" },
    ...models.slice(0, 2).map((m) => ({ label: m.name, model: m.id })),
  ]);
  const [mode, setMode] = useState<"request" | "full-access">("full-access");
  const [original, setOriginal] = useState<{ available: boolean; threads: { id: string; title: string; messageCount: number }[] }>({
    available: false,
    threads: [],
  });
  const [origThread, setOrigThread] = useState("");
  const [turns, setTurns] = useState<{ index: number; userText: string }[]>([]);
  const [turnIndex, setTurnIndex] = useState(-1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.evalCases().then((r) => setCases(r.cases), () => undefined);
    api.originalThreads().then(setOriginal, () => undefined);
  }, []);
  useEffect(() => {
    setTurns([]);
    setTurnIndex(-1);
    if (origThread) api.originalTurns(origThread).then((r) => setTurns(r.turns), (e: Error) => setError(e.message));
  }, [origThread]);

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.createCompare({
        prompt: prompt.trim() || undefined,
        caseId: caseId || undefined,
        permissionMode: mode,
        replicas: replicas.filter((x) => x.model),
        original: origThread && turnIndex >= 0 ? { threadId: origThread, turnIndex } : undefined,
      });
      onCreated(r.compare.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-title">新建对比</div>
      <div className="form-row">
        <label>评测用例</label>
        <select value={caseId} onChange={(e) => setCaseId(e.target.value)}>
          <option value="">（不使用用例）</option>
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label>问题</label>
        <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="留空则使用评测用例或原版会话中该轮的问题" />
      </div>
      <div className="form-row">
        <label>原版对照</label>
        {original.available ? (
          <>
            <select value={origThread} onChange={(e) => setOrigThread(e.target.value)}>
              <option value="">（不导入原版）</option>
              {original.threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}（{t.messageCount} 条）
                </option>
              ))}
            </select>
            {turns.length > 0 && (
              <select value={turnIndex} onChange={(e) => setTurnIndex(Number(e.target.value))}>
                <option value={-1}>选择轮次</option>
                {turns.map((t) => (
                  <option key={t.index} value={t.index}>
                    第 {t.index + 1} 轮：{t.userText.slice(0, 40)}
                  </option>
                ))}
              </select>
            )}
          </>
        ) : (
          <span className="muted">未配置 ORIGINAL_DB，或原版数据库不存在</span>
        )}
      </div>
      <div className="form-row">
        <label>复刻版配置</label>
        <div>
          {replicas.map((r, i) => (
            <div key={i} className="row">
              <input value={r.label} onChange={(e) => setReplicas((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} />
              <select value={r.model} onChange={(e) => setReplicas((x) => x.map((y, j) => (j === i ? { ...y, model: e.target.value } : y)))}>
                <option value="auto">自动路由</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.tier} · {m.name}
                  </option>
                ))}
              </select>
              <button onClick={() => setReplicas((x) => x.filter((_, j) => j !== i))}>删除</button>
            </div>
          ))}
          <button onClick={() => setReplicas((x) => [...x, { label: `配置 ${x.length + 1}`, model: "auto" }])}>+ 添加一列</button>
        </div>
      </div>
      <div className="form-row">
        <label>权限模式</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as "request" | "full-access")}>
          <option value="request">请求批准（命令需要在各列里逐个批准）</option>
          <option value="full-access">本地自动执行（付费仍确认）</option>
        </select>
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void create()}>
          开始对比
        </button>
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}

const fmtMs = (ms: number) => (ms > 60_000 ? `${(ms / 60_000).toFixed(1)} 分` : `${(ms / 1000).toFixed(1)} 秒`);

function CompareDetail({ id }: { id: string }) {
  const [data, setData] = useState<CompareView>();
  const [error, setError] = useState("");
  const [judging, setJudging] = useState(false);
  const allRuns = useRuns();

  const load = () => api.compare(id).then((r) => setData(r.compare), (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [id]);
  useEffect(() => {
    for (const c of data?.columns ?? []) if (c.kind === "replica") trackRun(c.runId, c.threadId, data!.prompt);
  }, [data]);

  const runsById = useMemo(() => new Map(allRuns.map((r) => [r.runId, r])), [allRuns]);
  const anyLive = data?.columns.some((c) => c.kind === "replica" && runsById.get(c.runId) && !runsById.get(c.runId)!.finished);
  useEffect(() => {
    // 运行结束后刷新一次指标。
    if (data && !anyLive) {
      const t = setTimeout(() => void load(), 1500);
      return () => clearTimeout(t);
    }
  }, [anyLive]);

  if (error) return <div className="error-text">{error}</div>;
  if (!data) return <div className="muted">加载中…</div>;

  const judge = async () => {
    setJudging(true);
    setError("");
    try {
      await api.judge(id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setJudging(false);
    }
  };

  const rows: [string, (c: CompareView["columns"][number]) => React.ReactNode][] = [
    ["状态", (c) => (c.kind === "replica" && runsById.get(c.runId) ? STATUS_LABEL[runsById.get(c.runId)!.status] : c.metrics.status)],
    ["模型", (c) => c.metrics.models.join("、") || "—"],
    ["升档次数", (c) => c.metrics.escalations],
    ["模型步数", (c) => c.metrics.steps],
    ["工具调用（失败）", (c) => `${c.metrics.toolCalls}（${c.metrics.toolErrors}）`],
    ["输入 / 输出 tokens", (c) => `${c.metrics.inputTokens.toLocaleString()} / ${c.metrics.outputTokens.toLocaleString()}`],
    ["估算成本", (c) => (c.metrics.costEstimate === null ? "未知" : c.metrics.costEstimate.toFixed(4))],
    ["耗时", (c) => fmtMs(c.metrics.durationMs)],
    ["交付文件", (c) => c.metrics.files.join("、") || "—"],
    ["断言通过", (c) => (c.assertions.length ? `${c.assertions.filter((a) => a.passed).length}/${c.assertions.length}` : "—")],
    ["评审得分", (c) => data.judge?.result.scores.find((s) => s.label === c.label)?.score ?? "—"],
  ];

  return (
    <div>
      <h3>{data.title}</h3>
      <div className="card">
        <div className="caption">问题</div>
        <div className="user-text">{data.prompt}</div>
      </div>
      <div className="note warn">
        局限：原版使用 deepseek-flash 和帮图云端 MCP，复刻版使用不同的模型、框架和自研工具，差异不能完全归因于模型。原版的成本单价未知，不做估算。
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>指标</th>
            {data.columns.map((c, i) => (
              <th key={i}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, fn]) => (
            <tr key={name}>
              <td>{name}</td>
              {data.columns.map((c, i) => (
                <td key={i}>{fn(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button className="primary" disabled={judging || Boolean(anyLive)} onClick={() => void judge()}>
          {judging ? "评审中…" : "让 L3 评审打分"}
        </button>
        <button onClick={() => void load()}>刷新指标</button>
      </div>
      {data.judge && (
        <div className="card">
          <div className="card-title">评审（{data.judge.modelId}）</div>
          <Markdown text={data.judge.result.summary} />
          {data.judge.result.scores.map((s) => (
            <div key={s.label}>
              <b>
                {s.label}：{s.score} 分
              </b>
              <div className="muted">优点：{s.strengths || "—"}</div>
              <div className="muted">不足：{s.weaknesses || "—"}</div>
            </div>
          ))}
        </div>
      )}
      <div className="columns">
        {data.columns.map((c, i) => {
          const live = c.kind === "replica" ? runsById.get(c.runId) : undefined;
          return (
            <div key={i} className="column">
              <div className="column-head">{c.label}</div>
              <div className="muted">工具序列：{c.metrics.toolSequence.join(" → ") || "无"}</div>
              {live && live.blocks.length ? (
                <Blocks blocks={live.blocks} runId={live.runId} live={!live.finished} waitingPlan={live.status === "waiting_plan"} />
              ) : (
                <Markdown text={c.metrics.finalText || "（无回答）"} />
              )}
              {c.assertions.map((a, j) => (
                <div key={j} className={a.passed ? "pass" : "fail"}>
                  {a.passed ? "✓" : "✗"} {a.assertion.type}：{String(a.assertion.value)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ComparePage({ models }: { models: ModelInfo[] }) {
  const [list, setList] = useState<{ id: string; title: string; createdAt: string }[]>([]);
  const [current, setCurrent] = useState<string>();
  const refresh = () => api.compares().then((r) => setList(r.compares), () => undefined);
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <div className="page">
      <h2>效果对比</h2>
      <div className="row">
        <button onClick={() => setCurrent(undefined)}>新建</button>
        {list.map((c) => (
          <button key={c.id} className={current === c.id ? "active" : ""} onClick={() => setCurrent(c.id)}>
            {c.title}
          </button>
        ))}
      </div>
      {current ? (
        <CompareDetail id={current} />
      ) : (
        <CreateForm
          models={models}
          onCreated={(id) => {
            void refresh();
            setCurrent(id);
          }}
        />
      )}
    </div>
  );
}
