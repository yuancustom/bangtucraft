import { createClient, type Client } from "@libsql/client";
import type { RunTrace } from "@drawing-agent/shared";

/** 每用户的运行追踪库（app.db）。一轮一行，trace 以 JSON 存储。 */
export class TraceStore {
  private client: Client;
  private ready: Promise<void>;

  constructor(file: string) {
    this.client = createClient({ url: `file:${file}` });
    this.ready = this.client
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL,
            trace TEXT NOT NULL
          )`,
          "CREATE INDEX IF NOT EXISTS runs_thread ON runs(thread_id, created_at)",
        ],
        "write",
      )
      .then(() => undefined);
  }

  async save(trace: RunTrace) {
    await this.ready;
    await this.client.execute({
      sql: `INSERT INTO runs (run_id, thread_id, created_at, status, trace) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, trace = excluded.trace`,
      args: [trace.runId, trace.threadId, trace.createdAt, trace.status, JSON.stringify(trace)],
    });
  }

  async get(runId: string): Promise<RunTrace | undefined> {
    await this.ready;
    const r = await this.client.execute({ sql: "SELECT trace FROM runs WHERE run_id = ?", args: [runId] });
    return r.rows[0] ? (JSON.parse(String(r.rows[0].trace)) as RunTrace) : undefined;
  }

  async list(options: { threadId?: string; limit?: number } = {}): Promise<RunTrace[]> {
    await this.ready;
    const r = options.threadId
      ? await this.client.execute({
          sql: "SELECT trace FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?",
          args: [options.threadId, options.limit ?? 100],
        })
      : await this.client.execute({ sql: "SELECT trace FROM runs ORDER BY created_at DESC LIMIT ?", args: [options.limit ?? 100] });
    return r.rows.map((row) => JSON.parse(String(row.trace)) as RunTrace);
  }

  async deleteThread(threadId: string) {
    await this.ready;
    await this.client.execute({ sql: "DELETE FROM runs WHERE thread_id = ?", args: [threadId] });
  }

  /** 进程重启时把未结束的运行标为失败。 */
  async failUnfinished() {
    await this.ready;
    const r = await this.client.execute("SELECT trace FROM runs WHERE status NOT IN ('completed','failed','cancelled')");
    for (const row of r.rows) {
      const trace = JSON.parse(String(row.trace)) as RunTrace;
      await this.save({ ...trace, status: "failed", error: trace.error ?? "进程重启，本轮已中断" });
    }
  }

  close() {
    this.client.close();
  }
}
