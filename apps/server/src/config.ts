import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotEnv } from "dotenv";
import { z } from "zod";
import { modelsFileSchema, type ModelsFile } from "./models/schema.ts";

// 仓库根目录：apps/server/src → 上三级。
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const requiredText = z.string().trim().min(1);
const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));
const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.url({ protocol: /^https?$/ }).optional());

const envSchema = z.object({
  CODEBUDDY_API_KEY: requiredText,
  OPENAI_API_KEY: requiredText,
  OPENAI_BASE_URL: z.url({ protocol: /^https?$/ }),
  GCMP_DWG_TOOLS: optionalText,
  BANGTU_API_KEY: optionalText,
  BANGTU_BUDGET_COINS: z.coerce.number().min(0).default(10),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  DATA_DIR: optionalText,
  HTTPS_PROXY: optionalUrl,
  NO_PROXY: optionalText,
  UV_EXE: optionalText,
  ORIGINAL_DB: optionalText,
  PYPI_INDEX_URL: optionalUrl,
  SEARXNG_URL: optionalUrl,
  SEARCH_MCP_PORT: z.coerce.number().int().min(1).max(65535).default(8790),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  rootDir: string;
  dataDir: string;
  host: string;
  port: number;
  /** 模型 / MCP 等使用的密钥，按环境变量名索引。只在进程内传递，不落日志。 */
  secrets: Record<string, string>;
  env: Env;
  models: ModelsFile;
}

/** 配置错误：只携带变量名或文件名，绝不携带取值。 */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`配置无效：\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** 读取仓库根目录的 .env；不存在时返回空对象。不写入 process.env。 */
export function readDotEnv(rootDir: string): Record<string, string> {
  const file = path.join(rootDir, ".env");
  if (!fs.existsSync(file)) return {};
  return parseDotEnv(fs.readFileSync(file));
}

function readModelsFile(rootDir: string, problems: string[]) {
  const file = path.join(rootDir, "config", "models.json");
  if (!fs.existsSync(file)) {
    problems.push("config/models.json: 文件不存在");
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    problems.push("config/models.json: 不是合法 JSON");
    return undefined;
  }
  const parsed = modelsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(根)"))];
    problems.push(`config/models.json: 结构非法（${fields.join(", ")}）`);
    return undefined;
  }
  return parsed.data;
}

/**
 * 加载配置。环境变量优先级：进程环境 > .env 文件。
 * 校验失败抛出 ConfigError，信息中只有变量名。
 */
export function loadConfig(options: {
  rootDir?: string;
  env?: Record<string, string | undefined>;
} = {}): AppConfig {
  const rootDir = options.rootDir ?? REPO_ROOT;
  const merged = { ...readDotEnv(rootDir), ...definedOnly(options.env ?? process.env) };
  const problems: string[] = [];

  const parsedEnv = envSchema.safeParse(merged);
  if (!parsedEnv.success) {
    const byName = new Map<string, string>();
    for (const issue of parsedEnv.error.issues) {
      const name = String(issue.path[0] ?? "(未知)");
      const value = merged[name];
      byName.set(name, value === undefined || value.trim() === "" ? "缺失" : "取值非法");
    }
    for (const [name, kind] of byName) problems.push(`${name}: ${kind}`);
  }

  const models = readModelsFile(rootDir, problems);
  if (models) {
    for (const provider of models.providers) {
      if (!merged[provider.apiKeyEnv]?.trim()) problems.push(`${provider.apiKeyEnv}: 缺失（模型接入点 ${provider.id}）`);
      if (provider.baseUrlEnv && !merged[provider.baseUrlEnv]?.trim())
        problems.push(`${provider.baseUrlEnv}: 缺失（模型接入点 ${provider.id}）`);
    }
  }
  if (problems.length || !parsedEnv.success || !models) throw new ConfigError([...new Set(problems)]);

  const env = parsedEnv.data;
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (/(_API_KEY|_SECRET|_TOKEN)$/.test(name) && value.trim()) secrets[name] = value.trim();
  }
  for (const provider of models.providers) {
    if (provider.baseUrlEnv) secrets[provider.baseUrlEnv] = merged[provider.baseUrlEnv]!.trim();
  }
  return {
    rootDir,
    dataDir: path.resolve(rootDir, env.DATA_DIR ?? "data"),
    host: env.HOST,
    port: env.PORT,
    secrets,
    env,
    models,
  };
}

function definedOnly(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}
