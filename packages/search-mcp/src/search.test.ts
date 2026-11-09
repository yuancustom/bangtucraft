import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { assertPublicUrl, createSearchTools, htmlToText } from "./tools.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function fakeServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("search_web", () => {
  it("调用 SearXNG JSON 接口并整理结果", async () => {
    let query = "";
    const url = await fakeServer((req, res) => {
      query = new URL(req.url!, "http://x").searchParams.get("q") ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [{ title: "GB 50016", url: "https://example.com/a", content: "建筑设计防火规范", engine: "bing" }] }));
    });
    const { search_web } = createSearchTools({ searxngUrl: url });
    const out = (await search_web.execute!({ query: "防火规范", limit: 5, language: "zh-CN" } as never, {} as never)) as {
      success: boolean;
      results: { title: string; url: string; snippet: string }[];
    };
    expect(query).toBe("防火规范");
    expect(out.success).toBe(true);
    expect(out.results[0]).toMatchObject({ title: "GB 50016", url: "https://example.com/a" });
  });

  it("服务不可用时如实返回失败", async () => {
    const { search_web } = createSearchTools({ searxngUrl: "http://127.0.0.1:1" });
    const out = (await search_web.execute!({ query: "x" } as never, {} as never)) as { success: boolean };
    expect(out.success).toBe(false);
  });
});

describe("fetch_url", () => {
  it("去掉脚本和样式，返回正文", async () => {
    const url = await fakeServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><head><title>标题</title><style>x{}</style></head><body><script>alert(1)</script><p>正文一</p><p>正文二</p></body></html>");
    });
    const { fetch_url } = createSearchTools({ searxngUrl: url, allowPrivateHosts: true });
    const out = (await fetch_url.execute!({ url, maxChars: 1000 } as never, {} as never)) as { title: string; content: string };
    expect(out.title).toBe("标题");
    expect(out.content).toContain("正文一");
    expect(out.content).not.toContain("alert");
  });

  it("默认拒绝本机与内网地址", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:8787/api")).rejects.toThrow("内网");
    await expect(assertPublicUrl("http://192.168.1.2/")).rejects.toThrow("内网");
    await expect(assertPublicUrl("file:///c:/x")).rejects.toThrow();
    const { fetch_url } = createSearchTools({ searxngUrl: "http://x" });
    const out = (await fetch_url.execute!({ url: "http://localhost:8787/" } as never, {} as never)) as { success: boolean };
    expect(out.success).toBe(false);
  });

  it("htmlToText 处理实体与换行", () => {
    const { text } = htmlToText("<p>a&amp;b</p><p>c&lt;d</p>");
    expect(text.split(/\s+/).filter(Boolean)).toEqual(["a&b", "c<d"]);
  });
});
