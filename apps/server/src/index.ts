import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { mcpConfigSchema, type McpConfig } from "./agent/mcp.ts";
import { discoverSkills } from "./agent/skills.ts";
import { ConfigError, loadConfig, type AppConfig } from "./config.ts";
import { AuthStore } from "./gateway/auth.ts";
import { CompareStore } from "./gateway/compare.ts";
import { OriginalImporter } from "./gateway/original.ts";
import { RunHub } from "./gateway/run-hub.ts";
import { WorkerPool } from "./gateway/worker-pool.ts";
import { ModelRegistry } from "./models/registry.ts";
import { setupNetwork } from "./network.ts";
import { Redactor } from "./redact.ts";

let config: AppConfig;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const redactor = new Redactor(Object.values(config.secrets));
const registry = new ModelRegistry(config.models, config.secrets);
setupNetwork({
  httpsProxy: config.env.HTTPS_PROXY,
  noProxy: config.env.NO_PROXY,
  models: config.models,
  resolveBaseUrl: (id) => registry.baseUrl(id),
});

function readMcpConfig(): McpConfig {
  const file = path.join(config.rootDir, "config", "mcp.json");
  if (!fs.existsSync(file)) return { servers: {} };
  const parsed = mcpConfigSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    console.error("config/mcp.json 结构非法，已忽略");
    return { servers: {} };
  }
  return parsed.data;
}

fs.mkdirSync(config.dataDir, { recursive: true });
const skills = discoverSkills(config.rootDir);
for (const p of skills.problems) console.warn(`[skills] 跳过 ${p.source}:${path.basename(p.path)} —— ${p.errors.join("；")}`);
console.log(`[skills] 已加载 ${skills.skills.length} 个 Skill`);

const mcp = readMcpConfig();
const hub = new RunHub();
const auth = new AuthStore(path.join(config.dataDir, "identity.db"));
const localUser = config.env.AUTH_MODE === "local" ? await auth.localUser(config.env.LOCAL_USER_ID) : undefined;
const here = path.dirname(fileURLToPath(import.meta.url));
const pool = new WorkerPool({
  entry: path.join(here, "gateway", "worker-entry.ts"),
  maxHeapMb: config.env.AGENT_HEAP_MB,
  init: (userId) => ({
    type: "init",
    userId,
    userDir: path.join(config.dataDir, "users", userId),
    rootDir: config.rootDir,
    models: config.models,
    secrets: config.secrets,
    skills,
    mcp,
    python: {
      uvExe: config.env.UV_EXE ?? "uv",
      root: path.join(config.dataDir, "python"),
      indexUrl: config.env.PYPI_INDEX_URL ?? "https://pypi.tuna.tsinghua.edu.cn/simple",
      httpsProxy: config.env.HTTPS_PROXY,
    },
    extraEnv: { GCMP_DWG_TOOLS: config.env.GCMP_DWG_TOOLS },
    network: { httpsProxy: config.env.HTTPS_PROXY, noProxy: config.env.NO_PROXY },
  }),
  onEvent: (userId, runId, body) => hub.push(userId, runId, body),
  onExit: (userId) => {
    console.warn(`[worker] 用户 ${userId} 的 Worker 退出，进行中的运行已标记失败；下次请求时自动重启`);
    hub.failUser(userId, "后台进程意外退出，本轮已中断，请重试");
  },
});

const app = createApp({
  auth,
  localUser,
  workers: pool,
  hub,
  registry,
  redactor,
  dataDir: config.dataDir,
  evalsDir: path.join(config.rootDir, "evals", "cases"),
  skills,
  original: new OriginalImporter(config.env.ORIGINAL_DB, path.join(config.dataDir, "original-snapshot")),
  compares: new CompareStore((userId) => path.join(config.dataDir, "users", userId, "compares")),
  webDist: path.join(config.rootDir, "apps", "web", "dist"),
});

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`server listening on http://${config.host}:${info.port}`);
});

const shutdown = async () => {
  server.close();
  await pool.close();
  auth.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
