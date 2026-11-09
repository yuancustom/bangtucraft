// 密钥脱敏：任何发往日志、SSE、模型的文本都应先过一遍。

const MASK = "[REDACTED]";

export class Redactor {
  private values: string[] = [];

  constructor(secrets: Iterable<string> = []) {
    for (const s of secrets) this.add(s);
  }

  add(secret: string | undefined) {
    // 太短的值（如 "10"）不当作密钥，避免误伤正常文本。
    if (!secret || secret.length < 8 || this.values.includes(secret)) return;
    this.values.push(secret);
    this.values.sort((a, b) => b.length - a.length);
  }

  text(input: string): string {
    let out = input;
    for (const v of this.values) if (out.includes(v)) out = out.split(v).join(MASK);
    // 通用兜底：Bearer 头与常见 key 形态。
    return out
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, `$1${MASK}`)
      .replace(/\b(sk|ck|bt-sk)[-_][A-Za-z0-9._-]{12,}/g, MASK);
  }

  value<T>(input: T, seen = new WeakSet<object>()): T {
    if (typeof input === "string") return this.text(input) as T;
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return input;
    seen.add(input);
    if (Array.isArray(input)) return input.map((v) => this.value(v, seen)) as T;
    if (input instanceof Date || ArrayBuffer.isView(input)) return input;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = /^(api[_-]?key|authorization|token|secret|password)$/i.test(k) && typeof v === "string" ? MASK : this.value(v, seen);
    }
    return out as T;
  }

  error(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return this.text(raw.split("\n").filter((l) => !/^\s+at\s/.test(l)).join("\n").trim() || "未知错误");
  }
}
