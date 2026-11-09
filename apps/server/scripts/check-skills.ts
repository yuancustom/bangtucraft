// 核实 Mastra Agent 原生加载器能读到哪些 Skill（只读，不调用模型）。用法：npx tsx scripts/check-skills.ts
import { Agent } from "@mastra/core/agent";
import { REPO_ROOT } from "../src/config.ts";
import { discoverSkills } from "../src/agent/skills.ts";

const catalog = discoverSkills(REPO_ROOT);
for (const p of catalog.problems) console.log("跳过", p.source, p.path, p.errors.join("；"));
const agent = new Agent({
  id: "check",
  name: "check",
  instructions: "x",
  model: { providerId: "x", modelId: "x", url: "http://127.0.0.1:1", apiKey: "x" },
  skills: catalog.skills.map((s) => s.path),
});
const listed = await agent.listSkills();
const names = new Set(listed.map((s) => s.name));
console.log(`发现 ${catalog.skills.length} 个，Agent 原生加载 ${listed.length} 个`);
for (const s of catalog.skills) if (!names.has(s.name)) console.log("Agent 未加载：", s.name);
for (const name of ["bangtu-elec-2d-to-3d", "dwg-to-dxf"]) {
  const skill = await agent.getSkill(name);
  console.log(`getSkill(${name})：`, skill ? `正文 ${String((skill as { instructions?: string }).instructions ?? "").length} 字符` : "null");
}
