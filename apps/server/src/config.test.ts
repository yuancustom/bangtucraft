import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";
import { fakeModelsFile } from "./test-utils/fake-openai.ts";

const SECRET_A = "fake-codebuddy-secret-value";
const SECRET_B = "fake-openai-secret-value";
const SECRET_C = "fake-provider-secret-value";

let root: string;

function writeModels(content: string) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "models.json"), content);
}

const validModels = JSON.stringify(fakeModelsFile("http://fake.test/v1"));
const validEnv = {
  CODEBUDDY_API_KEY: SECRET_A,
  OPENAI_API_KEY: SECRET_B,
  OPENAI_BASE_URL: "https://example.test/v1",
  FAKE_API_KEY: SECRET_C,
};

function captureError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("预期抛出 ConfigError");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-test-"));
  writeModels(validModels);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("合法配置加载成功并带默认值，密钥按变量名收集", () => {
    const config = loadConfig({ rootDir: root, env: validEnv });
    expect(config.port).toBe(8787);
    expect(config.host).toBe("127.0.0.1");
    expect(config.env.AUTH_MODE).toBe("local");
    expect(config.env.BANGTU_BUDGET_COINS).toBe(10);
    expect(config.dataDir).toBe(path.join(root, "data"));
    expect(config.secrets.FAKE_API_KEY).toBe(SECRET_C);
    expect(config.secrets.BANGTU_API_KEY).toBeUndefined();
  });

  it("从 .env 读取，进程环境优先", () => {
    fs.writeFileSync(
      path.join(root, ".env"),
      `CODEBUDDY_API_KEY=${SECRET_A}\nOPENAI_API_KEY=${SECRET_B}\nFAKE_API_KEY=${SECRET_C}\nOPENAI_BASE_URL=https://a.test/v1\nPORT=9000\n`,
    );
    const config = loadConfig({ rootDir: root, env: { PORT: "9100" } });
    expect(config.env.OPENAI_BASE_URL).toBe("https://a.test/v1");
    expect(config.port).toBe(9100);
  });

  it("支持切回独立账号并校验认证模式", () => {
    expect(loadConfig({ rootDir: root, env: { ...validEnv, AUTH_MODE: "accounts" } }).env.AUTH_MODE).toBe("accounts");
    expect(captureError(() => loadConfig({ rootDir: root, env: { ...validEnv, AUTH_MODE: "invalid" } })).problems).toContain("AUTH_MODE: 取值非法");
  });

  it("缺少必填变量时报出全部变量名（包括模型接入点要求的密钥）", () => {
    const error = captureError(() => loadConfig({ rootDir: root, env: { OPENAI_API_KEY: "  " } }));
    expect(error.problems).toEqual(
      expect.arrayContaining([
        "CODEBUDDY_API_KEY: 缺失",
        "OPENAI_API_KEY: 缺失",
        "OPENAI_BASE_URL: 缺失",
        "FAKE_API_KEY: 缺失（模型接入点 fake）",
      ]),
    );
  });

  it("非法取值被拒绝，且错误信息不含任何取值", () => {
    const badUrl = "ftp://secret-host-should-not-leak";
    const error = captureError(() =>
      loadConfig({
        rootDir: root,
        env: { ...validEnv, OPENAI_BASE_URL: badUrl, PORT: "70000", BANGTU_BUDGET_COINS: "-1", HTTPS_PROXY: "nope" },
      }),
    );
    expect(error.problems).toEqual(
      expect.arrayContaining([
        "OPENAI_BASE_URL: 取值非法",
        "PORT: 取值非法",
        "BANGTU_BUDGET_COINS: 取值非法",
        "HTTPS_PROXY: 取值非法",
      ]),
    );
    for (const value of [badUrl, SECRET_A, SECRET_B, SECRET_C, "70000"]) {
      expect(error.message).not.toContain(value);
    }
  });

  it("models.json 缺失、损坏或结构非法时被拒绝", () => {
    fs.rmSync(path.join(root, "config", "models.json"));
    expect(captureError(() => loadConfig({ rootDir: root, env: validEnv })).problems).toEqual([
      "config/models.json: 文件不存在",
    ]);

    writeModels("{ not json");
    expect(captureError(() => loadConfig({ rootDir: root, env: validEnv })).problems).toEqual([
      "config/models.json: 不是合法 JSON",
    ]);

    writeModels(JSON.stringify({ providers: {}, models: [] }));
    const problems = captureError(() => loadConfig({ rootDir: root, env: validEnv })).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^config\/models\.json: 结构非法（.*providers.*）$/);
  });
});
