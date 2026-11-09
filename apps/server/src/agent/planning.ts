import { z } from "zod";
import type { Plan } from "@drawing-agent/shared";

export const planSchema = z.object({
  goal: z.string().min(1),
  steps: z
    .array(
      z.object({
        title: z.string().min(1),
        detail: z.string().default(""),
        tools: z.array(z.string()).optional(),
        skills: z.array(z.string()).optional(),
      }),
    )
    .min(1)
    .max(30),
  deliverables: z.array(z.string()).default([]),
  executorTier: z.enum(["L1", "L2"]).default("L2"),
  risks: z.array(z.string()).optional(),
});

export const PLAN_FORMAT = `只输出一个 JSON 对象，不要输出其他内容，格式：
{"goal":"...","steps":[{"title":"...","detail":"...","tools":["..."],"skills":["..."]}],"deliverables":["..."],"executorTier":"L1|L2","risks":["..."]}`;

/** 从模型输出中提取并校验计划 JSON。 */
export function parsePlan(raw: string): Plan {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("计划输出中没有 JSON");
  const json = JSON.parse(raw.slice(start, end + 1)) as unknown;
  return planSchema.parse(json) as Plan;
}

export function planToText(plan: Plan): string {
  const steps = plan.steps
    .map((s, i) => {
      const extra = [s.tools?.length ? `工具：${s.tools.join("、")}` : "", s.skills?.length ? `技能：${s.skills.join("、")}` : ""]
        .filter(Boolean)
        .join("；");
      return `${i + 1}. ${s.title}${s.detail ? `——${s.detail}` : ""}${extra ? `（${extra}）` : ""}`;
    })
    .join("\n");
  return `目标：${plan.goal}\n步骤：\n${steps}\n交付物：${plan.deliverables.join("、") || "（无）"}${
    plan.risks?.length ? `\n注意：${plan.risks.join("；")}` : ""
  }`;
}
