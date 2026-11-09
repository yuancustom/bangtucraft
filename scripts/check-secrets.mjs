// 审计暂存区的确切字节；只报告路径与规则，从不输出命中的内容。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const envPath = path.join(root, ".env");
const env = fs.existsSync(envPath) ? require("dotenv").parse(fs.readFileSync(envPath)) : {};
const secrets = Object.entries(env).filter(([k, v]) => /(?:KEY|SECRET|TOKEN|PASSWORD)$/i.test(k) && v.length >= 8).map(([, v]) => v);
const git = (args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const paths = git(["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
const issues = [];
for (const name of paths) {
  if (/^(?:data|_extract|_tools|docs\/eval-reports|skills\/vendor-bangtu|deploy\/local)\//.test(name)
    || /(?:^|\/)\.env(?:\..*)?$/.test(name) && !name.endsWith(".env.example")
    || /\.(?:dwg|dxf|db|pem|key|exe)$/i.test(name) || name === "skills/local.json") {
    issues.push({ path: name, rule: "private-or-runtime-file" });
  }
  const bytes = git(["show", `:${name}`]);
  if (secrets.some((s) => bytes.includes(Buffer.from(s)) || bytes.includes(Buffer.from(s, "utf16le")))) issues.push({ path: name, rule: "configured-secret" });
  const text = bytes.toString("utf8");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) issues.push({ path: name, rule: "private-key" });
  if (/\b(?:sk-(?:proj-)?|gh[pousr]_)[A-Za-z0-9_-]{20,}/.test(text)) issues.push({ path: name, rule: "credential-pattern" });
}
if (!paths.length) throw new Error("暂存区为空，未执行发布审计");
console.log(JSON.stringify({ files: paths.length, issues }, null, 2));
if (issues.length) process.exitCode = 1;
