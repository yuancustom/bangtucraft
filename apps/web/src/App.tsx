import { useCallback, useEffect, useState } from "react";
import type { ModelInfo, SkillInfo, ThreadSummary } from "@drawing-agent/shared";
import { api, type User } from "./api.ts";
import { Login } from "./Login.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { ComparePage } from "./components/ComparePage.tsx";
import { ModelsPage } from "./components/ModelsPage.tsx";
import { forgetThread, trackRun, useRuns } from "./runs-store.ts";
import "./style.css";

type Page = { kind: "chat"; threadId?: string } | { kind: "models" } | { kind: "compare" };

function Main({ user, loginRequired, onLogout }: { user: User; loginRequired: boolean; onLogout: () => void }) {
  const [sessions, setSessions] = useState<ThreadSummary[]>([]);
  const [page, setPage] = useState<Page>({ kind: "chat" });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [error, setError] = useState("");
  const runs = useRuns();

  const refresh = useCallback(async () => {
    try {
      const r = await api.sessions();
      // 只显示普通会话；对比产生的会话在对比页查看。
      setSessions(r.sessions.filter((s) => !s.title.startsWith("[对比]")));
      // 刷新页面后恢复仍在运行的轮次。
      for (const a of r.active) trackRun(a.runId, a.threadId, "（运行中）");
      return r.sessions;
    } catch (e) {
      setError((e as Error).message);
      return [];
    }
  }, []);

  useEffect(() => {
    void refresh().then((list) => {
      const first = list.find((s) => !s.title.startsWith("[对比]"));
      if (first) setPage((p) => (p.kind === "chat" && !p.threadId ? { kind: "chat", threadId: first.id } : p));
    });
    api.models().then((r) => {
      setModels(r.models);
      setRoles(r.roles);
    }, () => undefined);
    api.skills().then((r) => setSkills(r.skills), () => undefined);
  }, [refresh]);

  // 运行结束后刷新列表以拿到自动生成的标题。
  const finishedCount = runs.filter((r) => r.finished).length;
  useEffect(() => {
    if (finishedCount) void refresh();
  }, [finishedCount, refresh]);

  const newSession = async () => {
    const r = await api.createSession();
    await refresh();
    setPage({ kind: "chat", threadId: r.session.id });
  };
  const rename = async (s: ThreadSummary) => {
    const title = prompt("新标题", s.title);
    if (title?.trim()) {
      await api.renameSession(s.id, title.trim()).catch((e: Error) => alert(e.message));
      await refresh();
    }
  };
  const remove = async (s: ThreadSummary) => {
    if (!confirm(`删除会话「${s.title}」？`)) return;
    try {
      await api.deleteSession(s.id);
      forgetThread(s.id);
      await refresh();
      if (page.kind === "chat" && page.threadId === s.id) setPage({ kind: "chat" });
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const running = new Set(runs.filter((r) => !r.finished).map((r) => r.threadId));
  const threadId = page.kind === "chat" ? page.threadId : undefined;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">帮帮图图</div>
        <button className="primary block" onClick={() => void newSession()}>
          + 新会话
        </button>
        <nav>
          <button className={page.kind === "models" ? "active" : ""} onClick={() => setPage({ kind: "models" })}>
            模型
          </button>
          <button className={page.kind === "compare" ? "active" : ""} onClick={() => setPage({ kind: "compare" })}>
            效果对比
          </button>
        </nav>
        <div className="sessions">
          {sessions.map((s) => (
            <div key={s.id} className={`session ${threadId === s.id ? "active" : ""}`} onClick={() => setPage({ kind: "chat", threadId: s.id })}>
              <span className="session-title" title={s.title}>
                {running.has(s.id) && <span className="dot" />}
                {s.title}
              </span>
              <span className="session-actions">
                <button
                  className="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    void rename(s);
                  }}
                >
                  改名
                </button>
                <button
                  className="link danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(s);
                  }}
                >
                  删除
                </button>
              </span>
            </div>
          ))}
        </div>
        <div className="me">
          {loginRequired ? user.username : "本地工作空间"}
          {loginRequired && <button className="link" onClick={onLogout}>
            退出
          </button>}
        </div>
      </aside>
      <main className="main">
        {error && <div className="note error">{error}</div>}
        {page.kind === "chat" &&
          (threadId ? (
            <ChatView key={threadId} threadId={threadId} models={models} skills={skills} onActivity={() => void refresh()} />
          ) : (
            <div className="empty">
              <button className="primary" onClick={() => void newSession()}>
                新建一个会话
              </button>
            </div>
          ))}
        {page.kind === "models" && <ModelsPage models={models} roles={roles} />}
        {page.kind === "compare" && <ComparePage models={models} />}
      </main>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<{ loading: boolean; user: User | null; canRegister: boolean; loginRequired: boolean; error?: string }>({ loading: true, user: null, canRegister: false, loginRequired: false });
  useEffect(() => {
    api.authStatus().then(
      (r) => setState({ loading: false, user: r.user, canRegister: r.canRegister, loginRequired: r.loginRequired }),
      () => setState({ loading: false, user: null, canRegister: false, loginRequired: false, error: "暂时无法连接服务，请刷新重试" }),
    );
  }, []);
  if (state.loading) return <div className="center muted">加载中…</div>;
  if (state.error) return <div className="center"><p>{state.error}</p><button onClick={() => location.reload()}>刷新</button></div>;
  if (!state.user) return <Login canRegister={state.canRegister} onLogin={(user) => setState({ ...state, user })} />;
  return (
    <Main
      user={state.user}
      loginRequired={state.loginRequired}
      onLogout={() => {
        void api.logout().finally(() => location.reload());
      }}
    />
  );
}
