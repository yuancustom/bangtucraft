import fs from "node:fs";
import path from "node:path";
import { validateSkillContent } from "@mastra/core/skills";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { SkillInfo, Tier } from "@drawing-agent/shared";

export interface SkillEntry extends SkillInfo {
  path: string;
}

export interface SkillProblem {
  path: string;
  source: SkillInfo["source"];
  errors: string[];
}

export interface SkillCatalog {
  skills: SkillEntry[];
  problems: SkillProblem[];
  tiers: Record<string, Tier>;
}

const localFileSchema = z.object({ skills: z.array(z.object({ path: z.string().min(1) })) });
const tierFileSchema = z.object({ tiers: z.record(z.string(), z.enum(["L1", "L2", "L3"])) });

function readFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  try {
    return (parseYaml(match[1]!) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

function inspect(dir: string, source: SkillInfo["source"], out: SkillCatalog, names: Set<string>) {
  const file = path.join(dir, "SKILL.md");
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, "utf8");
  const result = validateSkillContent({ content, directoryName: path.basename(dir) });
  if (!result.valid) {
    out.problems.push({ path: dir, source, errors: result.errors });
    return;
  }
  const meta = readFrontmatter(content);
  // 校验已保证 name 与目录名一致；YAML 解析失败时（部分 Skill 的 frontmatter 不是严格 YAML）回落到目录名与正则提取。
  const name = typeof meta.name === "string" ? meta.name : path.basename(dir);
  if (typeof meta.description !== "string") {
    const m = /^description:\s*(.*)$/m.exec(content);
    meta.description = m ? m[1]!.replace(/^["']|["']$/g, "") : "";
  }
  if (names.has(name)) {
    out.problems.push({ path: dir, source, errors: [`与已加载的同名 Skill 冲突：${name}，已跳过`] });
    return;
  }
  names.add(name);
  const metadata = (meta.metadata ?? {}) as Record<string, unknown>;
  const displayName = typeof metadata.display_name === "string" ? metadata.display_name : undefined;
  out.skills.push({
    name,
    description: String(meta.description ?? ""),
    source,
    path: dir,
    tier: out.tiers[name],
    ...(displayName ? { description: `${displayName}：${String(meta.description ?? "")}` } : {}),
  });
}

/**
 * 发现三类 Skill：skills/own、skills/local.json 登记的用户自有目录、skills/vendor-bangtu。
 * 同名时按 own > local > vendor 取第一个。不合法的 Skill 记入 problems，不交给 Mastra。
 */
export function discoverSkills(rootDir: string): SkillCatalog {
  const out: SkillCatalog = { skills: [], problems: [], tiers: {} };
  const tierFile = path.join(rootDir, "config", "skill-tiers.json");
  if (fs.existsSync(tierFile)) {
    const parsed = tierFileSchema.safeParse(JSON.parse(fs.readFileSync(tierFile, "utf8")));
    if (parsed.success) out.tiers = parsed.data.tiers;
  }
  const names = new Set<string>();
  const childDirs = (dir: string) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(dir, e.name))
          .sort()
      : [];

  for (const dir of childDirs(path.join(rootDir, "skills", "own"))) inspect(dir, "own", out, names);

  const localFile = path.join(rootDir, "skills", "local.json");
  if (fs.existsSync(localFile)) {
    const parsed = localFileSchema.safeParse(JSON.parse(fs.readFileSync(localFile, "utf8")));
    if (parsed.success) {
      for (const entry of parsed.data.skills) {
        const dir = path.resolve(rootDir, entry.path);
        if (!fs.existsSync(path.join(dir, "SKILL.md"))) out.problems.push({ path: dir, source: "local", errors: ["目录不存在或缺少 SKILL.md"] });
        else inspect(dir, "local", out, names);
      }
    } else out.problems.push({ path: localFile, source: "local", errors: ["skills/local.json 结构非法"] });
  }

  for (const dir of childDirs(path.join(rootDir, "skills", "vendor-bangtu"))) inspect(dir, "vendor-bangtu", out, names);
  return out;
}
