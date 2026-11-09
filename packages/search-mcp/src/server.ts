// 自建搜索 MCP：包装本机 SearXNG，提供 search_web 与 fetch_url。
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { MCPServer } from "@mastra/mcp";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { createSearchTools } from "./tools.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: path.join(root, ".env"), quiet: true });

const port = Number(process.env.SEARCH_MCP_PORT ?? 8790);
const searxngUrl = process.env.SEARXNG_URL ?? "http://127.0.0.1:8888";
if (process.env.HTTPS_PROXY) {
  setGlobalDispatcher(
    new EnvHttpProxyAgent({ httpsProxy: process.env.HTTPS_PROXY, httpProxy: process.env.HTTPS_PROXY, noProxy: "localhost,127.0.0.1,::1" }),
  );
}

export function createSearchServer(searxng: string) {
  return new MCPServer({
    id: "search",
    name: "search",
    version: "1.0.0",
    description: "联网搜索与网页读取",
    tools: createSearchTools({ searxngUrl: searxng }),
  });
}

const server = createSearchServer(searxngUrl);
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
    return;
  }
  await server.startHTTP({ url, httpPath: "/mcp", req, res });
});
httpServer.listen(port, "127.0.0.1", () => {
  console.log(`search-mcp listening on http://127.0.0.1:${port}/mcp (SearXNG: ${searxngUrl})`);
});
