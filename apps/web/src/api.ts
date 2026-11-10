import type {
  HistoryMessage,
  ModelInfo,
  RunEvent,
  RunTrace,
  SendMessageRequest,
  SkillInfo,
  ThreadSummary,
} from "@drawing-agent/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined || body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `请求失败（HTTP ${res.status}）`, res.status);
  return data as T;
}

export interface User {
  id: string;
  username: string;
}

export const api = {
  authStatus: () => request<{ user: User | null; loginRequired: boolean; canRegister: boolean; maxUsers: number }>("GET", "/api/auth/status"),
  login: (username: string, password: string) => request<{ user: User }>("POST", "/api/auth/login", { username, password }),
  register: (username: string, password: string) => request<{ user: User }>("POST", "/api/auth/register", { username, password }),
  logout: () => request("POST", "/api/auth/logout"),

  models: () => request<{ models: ModelInfo[]; roles: Record<string, string> }>("GET", "/api/models"),
  ping: (id: string) => request<{ ok: boolean; latencyMs?: number; reply?: string; error?: string }>("POST", `/api/models/${encodeURIComponent(id)}/ping`),
  discover: (provider: string) => request<{ models: string[] }>("GET", `/api/models/discover/${encodeURIComponent(provider)}`),
  skills: () => request<{ skills: SkillInfo[]; problems: { name?: string; source: string; errors: string[] }[] }>("GET", "/api/skills"),

  sessions: () => request<{ sessions: ThreadSummary[]; active: { runId: string; threadId: string }[] }>("GET", "/api/sessions"),
  createSession: (title?: string) => request<{ session: ThreadSummary }>("POST", "/api/sessions", { title }),
  renameSession: (id: string, title: string) => request("PATCH", `/api/sessions/${id}`, { title }),
  deleteSession: (id: string) => request("DELETE", `/api/sessions/${id}`),
  history: (id: string) => request<{ messages: HistoryMessage[] }>("GET", `/api/sessions/${id}/messages`),
  runs: (id: string) => request<{ runs: RunTrace[] }>("GET", `/api/sessions/${id}/runs`),
  send: (id: string, body: SendMessageRequest) => request<{ runId: string }>("POST", `/api/sessions/${id}/messages`, body),

  approve: (runId: string, toolCallId: string, approved: boolean, reason?: string) =>
    request("POST", `/api/runs/${runId}/approval`, { toolCallId, approved, reason }),
  answer: (runId: string, toolCallId: string, selectedIds: string[], text: string) =>
    request("POST", `/api/runs/${runId}/question`, { toolCallId, selectedIds, text }),
  plan: (runId: string, action: "approve" | "reject" | "revise", feedback?: string) => request("POST", `/api/runs/${runId}/plan`, { action, feedback }),
  abort: (runId: string) => request("POST", `/api/runs/${runId}/abort`, {}),

  upload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ path: string; size: number }>("POST", "/api/files/upload", form);
  },
  preview: (path: string) => request<{ html: string }>("GET", `/api/files/preview?path=${encodeURIComponent(path)}`),

  evalCases: () => request<{ cases: { id: string; title: string; prompt: string }[]; errors: string[] }>("GET", "/api/evals/cases"),
  originalThreads: () =>
    request<{ available: boolean; threads: { id: string; title: string; updatedAt: string; messageCount: number }[] }>("GET", "/api/original/threads"),
  originalTurns: (id: string) => request<{ turns: { index: number; userText: string; startedAt: string }[] }>("GET", `/api/original/threads/${id}`),
  compares: () => request<{ compares: { id: string; title: string; createdAt: string }[] }>("GET", "/api/compare"),
  createCompare: (body: unknown) => request<{ compare: { id: string } }>("POST", "/api/compare", body),
  compare: (id: string) => request<{ compare: CompareView }>("GET", `/api/compare/${id}`),
  judge: (id: string) => request<{ judge: CompareView["judge"] }>("POST", `/api/compare/${id}/judge`),
};

export const fileUrl = (path: string, download = false) => `/api/files/raw?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;

export interface ColumnMetrics {
  status: string;
  models: string[];
  escalations: number;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  toolSequence: string[];
  inputTokens: number;
  outputTokens: number;
  costEstimate: number | null;
  durationMs: number;
  files: string[];
  finalText: string;
}

export interface CompareView {
  id: string;
  title: string;
  prompt: string;
  rubric: string;
  createdAt: string;
  columns: ((
    | { kind: "replica"; label: string; model: string; threadId: string; runId: string }
    | { kind: "original"; label: string }
  ) & { metrics: ColumnMetrics; assertions: { assertion: { type: string; value: unknown }; passed: boolean }[] })[];
  judge?: { modelId: string; at: string; result: { scores: { label: string; score: number; strengths: string; weaknesses: string }[]; summary: string } };
}

/** 订阅一轮运行的事件；断线后按 seq 续传。返回取消函数。 */
export function subscribeRun(
  runId: string,
  onEvent: (e: RunEvent) => void,
  onGone?: () => void,
  onConnectionChange?: (reconnecting: boolean) => void,
  onRecovered?: (trace: RunTrace) => void,
): () => void {
  let lastSeq = 0;
  let closed = false;
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let probe: AbortController | undefined;
  let failures = 0;
  const close = () => {
    closed = true;
    source?.close();
    probe?.abort();
    if (retry) clearTimeout(retry);
  };
  const open = () => {
    if (closed) return;
    source = new EventSource(`/api/runs/${runId}/events?after=${lastSeq}`);
    source.addEventListener("run", (msg) => {
      const e = JSON.parse((msg as MessageEvent<string>).data) as RunEvent;
      if (e.seq <= lastSeq) return;
      lastSeq = e.seq;
      onEvent(e);
      if (e.type === "done") {
        close();
        onConnectionChange?.(false);
      }
    });
    source.onopen = () => {
      failures = 0;
      onConnectionChange?.(false);
    };
    source.onerror = async () => {
      source?.close();
      if (closed) return;
      onConnectionChange?.(true);
      failures++;
      probe = new AbortController();
      const timeout = setTimeout(() => probe?.abort(), 8000);
      try {
        const res = await fetch(`/api/runs/${runId}`, { credentials: "same-origin", signal: probe.signal });
        if (closed) return;
        if (res.status === 404) {
          const body = await res.json().catch(() => null) as { error?: string } | null;
          if (closed) return;
          // 旧版本网关或代理默认404不能证明后台任务已消失。
          if (body?.error === "运行不存在或已过期") {
            close();
            onGone?.();
            return;
          }
        }
        if (res.ok) {
          const data = await res.json() as { trace?: RunTrace };
          if (closed) return;
          if (data.trace && onRecovered) {
            close();
            onRecovered(data.trace);
            return;
          }
        }
      } catch { /* 网关重启或网络暂不可用：持续重连，不把任务判为失败。 */ }
      finally { clearTimeout(timeout); }
      if (!closed) {
        retry = setTimeout(open, Math.min(1000 * 2 ** Math.min(failures, 4), 10_000));
      }
    };
  };
  open();
  return close;
}
