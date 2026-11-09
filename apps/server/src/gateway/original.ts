import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface OriginalThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface OriginalTurn {
  index: number;
  userText: string;
  assistantText: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  models: string[];
  inputTokens: number;
  outputTokens: number;
  steps: number;
  toolCalls: { toolName: string; isError: boolean }[];
  files: string[];
}

interface MsgRow {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

interface SpanRow {
  spanType: string;
  name: string;
  a: string | null;
  startedAt: string;
  endedAt: string | null;
}

function partsOf(content: string): { type?: string; text?: string; toolInvocation?: { toolName?: string; args?: unknown; result?: unknown } }[] {
  try {
    const parsed = JSON.parse(content) as { parts?: unknown[]; content?: string };
    if (Array.isArray(parsed.parts)) return parsed.parts as never;
    if (typeof parsed.content === "string") return [{ type: "text", text: parsed.content }];
  } catch {
    /* 旧格式 */
  }
  return [{ type: "text", text: content }];
}

function toolNameFromSpan(name: string): string {
  return /'([^']+)'/.exec(name)?.[1] ?? name;
}

/**
 * 只读导入原版帮图Mind 的数据库。原库可能正被原版软件使用，
 * 因此先把 db 与 -wal 复制成快照，只读快照，绝不写原库。
 */
export class OriginalImporter {
  constructor(
    private readonly source: string | undefined,
    private readonly snapshotDir: string,
  ) {}

  available(): boolean {
    return Boolean(this.source && fs.existsSync(this.source));
  }

  private open(): DatabaseSync {
    if (!this.source || !fs.existsSync(this.source)) throw new Error("未配置原版数据库（ORIGINAL_DB）或文件不存在");
    fs.mkdirSync(this.snapshotDir, { recursive: true });
    const target = path.join(this.snapshotDir, "bangtu.db");
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(target + suffix, { force: true });
    fs.copyFileSync(this.source, target);
    if (fs.existsSync(this.source + "-wal")) fs.copyFileSync(this.source + "-wal", target + "-wal");
    return new DatabaseSync(target);
  }

  listThreads(): OriginalThread[] {
    const db = this.open();
    try {
      const rows = db
        .prepare(
          `SELECT t.id, t.title, t.createdAt, t.updatedAt, (SELECT COUNT(*) FROM mastra_messages m WHERE m.thread_id = t.id) AS n
           FROM mastra_threads t ORDER BY t.updatedAt DESC LIMIT 500`,
        )
        .all() as { id: string; title: string | null; createdAt: string; updatedAt: string; n: number }[];
      return rows
        .filter((r) => r.n > 0)
        .map((r) => ({ id: r.id, title: r.title || "（无标题）", createdAt: r.createdAt, updatedAt: r.updatedAt, messageCount: Number(r.n) }));
    } finally {
      db.close();
    }
  }

  /** 按用户消息切分轮次，并用时间窗口归集该轮的模型用量与工具调用。 */
  turns(threadId: string): OriginalTurn[] {
    const db = this.open();
    try {
      const messages = db
        .prepare("SELECT id, role, content, createdAt FROM mastra_messages WHERE thread_id = ? ORDER BY createdAt ASC")
        .all(threadId) as unknown as MsgRow[];
      const spans = db
        .prepare(
          `SELECT spanType, name, json(attributes) AS a, startedAt, endedAt FROM mastra_ai_spans
           WHERE threadId = ? AND spanType IN ('agent_run','model_generation','model_step','tool_call','mcp_tool_call') ORDER BY startedAt ASC`,
        )
        .all(threadId) as unknown as SpanRow[];
      const turns: OriginalTurn[] = [];
      let current: OriginalTurn | undefined;
      for (const m of messages) {
        const parts = partsOf(m.content);
        if (m.role === "user") {
          current = {
            index: turns.length,
            userText: parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join(""),
            assistantText: "",
            startedAt: m.createdAt,
            endedAt: m.createdAt,
            durationMs: 0,
            models: [],
            inputTokens: 0,
            outputTokens: 0,
            steps: 0,
            toolCalls: [],
            files: [],
          };
          turns.push(current);
        } else if (m.role === "assistant" && current) {
          for (const p of parts) {
            if (p.type === "text" && p.text) current.assistantText += (current.assistantText ? "\n" : "") + p.text;
            if (p.type === "tool-invocation" && p.toolInvocation?.toolName === "present_files") {
              const paths = (p.toolInvocation.args as { paths?: string[] } | undefined)?.paths ?? [];
              current.files.push(...paths);
            }
          }
          current.endedAt = m.createdAt;
        }
      }
      turns.forEach((turn, i) => {
        const from = turn.startedAt;
        const to = turns[i + 1]?.startedAt ?? "9999";
        let lastEnd = turn.endedAt;
        for (const s of spans) {
          if (s.startedAt < from || s.startedAt >= to) continue;
          if (s.endedAt && s.endedAt > lastEnd) lastEnd = s.endedAt;
          const attrs = (() => {
            try {
              return s.a ? (JSON.parse(s.a) as Record<string, any>) : {};
            } catch {
              return {};
            }
          })();
          if (s.spanType === "model_generation") {
            if (attrs.model && !turn.models.includes(attrs.model)) turn.models.push(String(attrs.model));
            turn.inputTokens += Number(attrs.usage?.inputTokens ?? 0);
            turn.outputTokens += Number(attrs.usage?.outputTokens ?? 0);
          } else if (s.spanType === "model_step") turn.steps += 1;
          else if (s.spanType === "tool_call" || s.spanType === "mcp_tool_call") {
            turn.toolCalls.push({ toolName: toolNameFromSpan(s.name), isError: attrs.success === false });
          }
        }
        turn.endedAt = lastEnd;
        turn.durationMs = Math.max(0, new Date(lastEnd).getTime() - new Date(from).getTime());
      });
      return turns;
    } finally {
      db.close();
    }
  }
}
