// Temporary local-only UI fixture using the production gateway and real workers.
// Run with tsx from apps/server. No real keys, cloud MCP, or user databases.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createApp } from "../apps/server/src/app.ts";
import { AuthStore } from "../apps/server/src/gateway/auth.ts";
import { CompareStore } from "../apps/server/src/gateway/compare.ts";
import { OriginalImporter } from "../apps/server/src/gateway/original.ts";
import { RunHub } from "../apps/server/src/gateway/run-hub.ts";
import { WorkerPool } from "../apps/server/src/gateway/worker-pool.ts";
import { Redactor } from "../apps/server/src/redact.ts";
import { ModelRegistry } from "../apps/server/src/models/registry.ts";
import { fakeModelsFile, startFakeOpenAI, FAKE_SECRET } from "../apps/server/src/test-utils/fake-openai.ts";

const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { serve } = require("@hono/node-server");
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bangtu-ui-acceptance-"));
const fake = await startFakeOpenAI(b => {
  const system = (b.messages ?? []).filter(m => m.role === "system").map(m => JSON.stringify(m.content)).join("\n");
  const user = [...(b.messages ?? [])].reverse().find(m => m.role === "user")?.content;
  const text = typeof user === "string" ? user : JSON.stringify(user);
  if (system.includes("任务难度分类器")) return { text: JSON.stringify({ tier: text.includes("complex") ? "complex" : "standard" }) };
  if (system.includes("任务规划者")) return { text: JSON.stringify({ goal: "UI acceptance plan", steps: [{ title: "Verify output" }], deliverables: [], executorTier: "L2" }) };
  if (system.includes("会话标题") || text.includes("会话标题")) return { text: "验收会话" };
  const messages = b.messages ?? [];
  const lastUser = messages.map(m => m.role).lastIndexOf("user");
  const toolResults = messages.slice(lastUser + 1).filter(m => m.role === "tool");
  if (toolResults.length) {
    if (text.includes("file") && !JSON.stringify(toolResults).includes("mediaType")) return { toolCalls: [{ name: "present_files", args: { paths: ["report.html"] } }] };
    return { text: `验收回答：${text}`, reasoning: "本地假模型验证完成" };
  }
  if (text.includes("approval")) return { toolCalls: [{ name: "local_command_execute", args: { command: "Write-Output ui-acceptance" } }] };
  if (text.includes("question")) return { toolCalls: [{ name: "ask_user", args: { question: "请选择验收方案", options: [{ id: "a", label: "方案 A" }, { id: "b", label: "方案 B" }] } }] };
  if (text.includes("file")) return { toolCalls: [{ name: "local_command_execute", args: { command: "[IO.File]::WriteAllText((Join-Path (Get-Location) 'report.html'), '<!doctype html><html><body><h1>Acceptance report</h1><p>Local fixture only.</p></body></html>')" } }] };
  return { text: `验收回答：${text}`, reasoning: "本地假模型验证完成", delayMs: text.includes("slow") ? 100 : 0 };
});
const models = fakeModelsFile(fake.url);
const secrets = { FAKE_API_KEY: FAKE_SECRET };
const skills = { skills: [], problems: [], tiers: {} };
const hub = new RunHub();
const auth = new AuthStore(path.join(dataDir, "identity.db"));
const redactor = new Redactor([FAKE_SECRET]);
const pool = new WorkerPool({
  entry: fileURLToPath(new URL("../apps/server/src/gateway/worker-entry.ts", import.meta.url)),
  init: userId => ({ type: "init", userId, userDir: path.join(dataDir, "users", userId), rootDir, models, secrets, skills,
    mcp: { servers: {} }, python: { uvExe: "uv", root: path.join(dataDir, "python"), indexUrl: "https://pypi.invalid/simple" },
    extraEnv: {}, network: {},
  }),
  onEvent: (u, r, b) => hub.push(u, r, b), onExit: u => hub.failUser(u, "fixture worker exited"),
});
const app = createApp({ auth, workers: pool, hub, registry: new ModelRegistry(models, secrets), redactor, dataDir,
  evalsDir: path.join(rootDir, "evals", "cases"), skills, original: new OriginalImporter(undefined, path.join(dataDir, "snap")),
  compares: new CompareStore(u => path.join(dataDir, "users", u, "compares")), webDist: path.join(rootDir, "apps", "web", "dist"),
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 18887 }, () => console.log(JSON.stringify({ url: "http://127.0.0.1:18887", dataDir })));
const close = async () => { server.close(); await pool.close(); auth.close(); await fake.close(); process.exit(0); };
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
