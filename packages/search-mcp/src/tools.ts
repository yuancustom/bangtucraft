import dns from "node:dns/promises";
import net from "node:net";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export interface SearchOptions {
  searxngUrl: string;
  /** 测试时可放行本机地址。 */
  allowPrivateHosts?: boolean;
  fetchImpl?: typeof fetch;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const lower = ip.toLowerCase();
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80") || lower.startsWith("::ffff:127.");
}

/** 拒绝访问本机与内网地址，防止经 fetch_url 探测内部服务。 */
export async function assertPublicUrl(raw: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL 不合法");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 http/https");
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateIp)) throw new Error("不允许访问本机或内网地址");
  return url;
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const text = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return { title, text };
}

export function createSearchTools(options: SearchOptions) {
  const doFetch = options.fetchImpl ?? fetch;

  const search_web = createTool({
    id: "search_web",
    description: "联网搜索网页，返回标题、链接和摘要。需要原文时再用 fetch_url 读取。",
    inputSchema: z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(20).default(8),
      language: z.string().max(10).default("zh-CN"),
    }),
    execute: async ({ query, limit, language }) => {
      const url = new URL("/search", options.searxngUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("language", language ?? "zh-CN");
      try {
        const r = await doFetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) return { success: false, error: `搜索服务返回 HTTP ${r.status}` };
        const body = (await r.json()) as { results?: { title?: string; url?: string; content?: string; engine?: string }[] };
        const results = (body.results ?? []).slice(0, limit ?? 8).map((x) => ({
          title: x.title ?? "",
          url: x.url ?? "",
          snippet: (x.content ?? "").slice(0, 500),
          engine: x.engine,
        }));
        return { success: true, query, results };
      } catch (error) {
        return { success: false, error: `搜索服务不可用：${(error as Error).message}` };
      }
    },
  });

  const fetch_url = createTool({
    id: "fetch_url",
    description: "读取一个公开网页或文本链接的正文（去掉脚本和样式），用于核对搜索结果的原文。",
    inputSchema: z.object({ url: z.string().min(1).max(4000), maxChars: z.number().int().min(500).max(100_000).default(20_000) }),
    execute: async ({ url, maxChars }) => {
      try {
        const target = await assertPublicUrl(url, options.allowPrivateHosts);
        const r = await doFetch(target, { signal: AbortSignal.timeout(30_000), redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 drawing-agent" } });
        if (!r.ok) return { success: false, error: `HTTP ${r.status}` };
        if (r.url && r.url !== target.href) await assertPublicUrl(r.url, options.allowPrivateHosts);
        const type = r.headers.get("content-type") ?? "";
        if (!/text|json|xml|html/.test(type)) return { success: false, error: `不支持的内容类型：${type}` };
        const raw = await r.text();
        const { title, text } = /html/.test(type) ? htmlToText(raw) : { title: "", text: raw };
        const limit = maxChars ?? 20_000;
        return { success: true, url: r.url || target.href, title, content: text.slice(0, limit), truncated: text.length > limit };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  });

  return { search_web, fetch_url };
}
