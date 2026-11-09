import type { FileCard, HistoryMessage, HistoryPart } from "@drawing-agent/shared";

interface DbPart {
  type?: string;
  text?: string;
  reasoning?: string;
  details?: { type?: string; text?: string }[];
  toolInvocation?: { toolCallId?: string; toolName?: string; args?: unknown; result?: unknown; state?: string };
}

interface DbMessage {
  id: string;
  role: string;
  createdAt: Date | string;
  content: { parts?: DbPart[]; content?: string } | string;
}

function filesFrom(result: unknown): FileCard[] {
  if (!result || typeof result !== "object") return [];
  const files = (result as { files?: unknown }).files;
  return Array.isArray(files) ? (files as FileCard[]).filter((f) => f && typeof f.path === "string") : [];
}

/** 把 Mastra 存储的消息转成前端展示用的片段。 */
export function toHistory(messages: DbMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const parts: HistoryPart[] = [];
    const content = m.content;
    if (typeof content === "string") parts.push({ type: "text", text: content });
    else {
      for (const p of content.parts ?? []) {
        if (p.type === "text" && p.text) parts.push({ type: "text", text: p.text });
        else if (p.type === "reasoning") {
          const text = p.reasoning || (p.details ?? []).map((d) => d.text ?? "").join("");
          if (text) parts.push({ type: "reasoning", text });
        } else if (p.type === "tool-invocation" && p.toolInvocation) {
          const t = p.toolInvocation;
          const result = t.state === "result" ? t.result : undefined;
          parts.push({
            type: "tool",
            toolCallId: t.toolCallId ?? "",
            toolName: t.toolName ?? "",
            args: t.args,
            result,
            isError: Boolean(result && typeof result === "object" && (result as { success?: unknown }).success === false),
          });
          if (t.toolName === "present_files") {
            const files = filesFrom(result);
            if (files.length) parts.push({ type: "files", files });
          }
        }
      }
      if (!parts.length && content.content) parts.push({ type: "text", text: content.content });
    }
    if (!parts.length) continue;
    const role = m.role as "user" | "assistant";
    const last = out[out.length - 1];
    // 同一轮助手回复可能拆成多条消息，合并展示。
    if (role === "assistant" && last?.role === "assistant") last.parts.push(...parts);
    else out.push({ id: m.id, role, createdAt: new Date(m.createdAt).toISOString(), parts });
  }
  return out;
}
