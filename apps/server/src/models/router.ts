import type { RouteDecision, Tier } from "@drawing-agent/shared";
import { ModelRegistry } from "./registry.ts";

export type Complexity = RouteDecision["complexity"];

export interface RouteInput {
  text: string;
  /** "auto" 或具体模型 ID。 */
  model: string;
  hasImages: boolean;
  skills: string[];
}

export interface RouterDeps {
  registry: ModelRegistry;
  /** Skill 名称 → 难度档位。 */
  skillTiers: Record<string, Tier>;
  /** L1 短分类；失败时抛错。 */
  classify: (text: string) => Promise<Complexity>;
}

const COMPLEXITY_TIER: Record<Complexity, Tier> = { simple: "L1", standard: "L2", complex: "L3" };
const TIER_COMPLEXITY: Record<Tier, Complexity> = { L1: "simple", L2: "standard", L3: "complex" };
const TIER_ORDER: Tier[] = ["L1", "L2", "L3"];

export const CLASSIFIER_PROMPT = `你是任务难度分类器。只输出一行 JSON：{"tier":"simple|standard|complex"}，不要解释。
- simple：闲聊、常识问答、单步操作、改写翻译、按明确指令执行一两步。
- standard：需要多步工具调用、读写文件、运行命令或脚本、按技能流程执行、联网查证。
- complex：开放式或多阶段任务，需要先规划方案再执行；涉及图纸理解、三维建模、规范审查、多文件交付，或需求含糊需要拆解。`;

export function parseComplexity(raw: string): Complexity {
  const match = /"tier"\s*:\s*"(simple|standard|complex)"/.exec(raw) ?? /\b(simple|standard|complex)\b/.exec(raw);
  if (!match) throw new Error("分类器输出无法解析");
  return match[1] as Complexity;
}

function maxTier(tiers: Tier[]): Tier | undefined {
  let best: Tier | undefined;
  for (const t of tiers) if (!best || TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf(best)) best = t;
  return best;
}

/** 选模型：硬规则 → L1 分类 → 是否先规划。 */
export async function routeTask(input: RouteInput, deps: RouterDeps): Promise<RouteDecision> {
  const reasons: string[] = [];

  if (input.model !== "auto") {
    const model = deps.registry.get(input.model);
    reasons.push(`用户指定模型 ${model.id}`);
    if (input.hasImages && !model.capabilities.images) {
      const fallback = deps.registry.forTier(ModelRegistry.tierAtLeast(model.tier, "L2"));
      reasons.push(`${model.id} 不支持图片，改用 ${fallback.id}`);
      return { tier: fallback.tier, modelId: fallback.id, complexity: "standard", plan: false, reasons };
    }
    return { tier: model.tier, modelId: model.id, complexity: TIER_COMPLEXITY[model.tier], plan: false, reasons };
  }

  let complexity: Complexity;
  const skillTier = maxTier(input.skills.map((s) => deps.skillTiers[s]).filter((t): t is Tier => Boolean(t)));
  if (skillTier) {
    complexity = TIER_COMPLEXITY[skillTier];
    reasons.push(`所选技能标注难度 ${skillTier}`);
  } else if (input.skills.length) {
    complexity = "standard";
    reasons.push("所选技能未标注难度，按 standard 处理");
  } else {
    try {
      complexity = await deps.classify(input.text);
      reasons.push(`L1 分类为 ${complexity}`);
    } catch {
      complexity = "standard";
      reasons.push("分类失败，按 standard 处理");
    }
  }

  let tier = COMPLEXITY_TIER[complexity];
  if (input.hasImages && tier === "L1") {
    tier = "L2";
    reasons.push("输入含图片，至少使用 L2");
  }
  const plan = complexity === "complex";
  if (plan) reasons.push("complex 任务先由 L3 规划，确认后执行");
  const model = deps.registry.forTier(tier);
  return { tier, modelId: model.id, complexity, plan, reasons };
}

// ---------------- 运行中升档 ----------------

const POLLING_TOOL = /(status|wait|poll|list|get_frame_result|get_cv_result)/i;
const DELIVERY_CLAIM = /(已(生成|交付|导出|保存|创建)|文件卡片|已为你(生成|准备)|见附件)/;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function isToolFailure(result: unknown): boolean {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.success === false || r.isError === true) return true;
    if (typeof r.exitCode === "number" && r.exitCode !== 0) return true;
    if (typeof r.error === "string" && r.error) return true;
  }
  return false;
}

const RASTER = /^image\/(png|jpe?g|gif|webp|bmp)$/;

/** 工具结果里是否带有需要模型“看”的图片内容（不是文件元数据，如 present_files 的 mediaType）。 */
export function resultHasImage(result: unknown, depth = 0): boolean {
  if (depth > 4 || !result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (r.type === "image" || r.type === "image_url") return true;
  const media = [r.mediaType, r.mimeType, r.mime_type].find((v) => typeof v === "string") as string | undefined;
  if (media && RASTER.test(media) && ["data", "image", "base64", "url"].some((k) => k in r)) return true;
  return Object.values(r).some((v) => resultHasImage(v, depth + 1));
}

export function claimsDeliveryWithoutFiles(text: string, presentFilesCalled: boolean): boolean {
  return !presentFilesCalled && DELIVERY_CLAIM.test(text);
}

/** 跟踪本轮工具调用，给出升档原因。每轮最多升 maxEscalations 次，最高 L3。 */
export class EscalationTracker {
  tier: Tier;
  escalations: { fromTier: Tier; toTier: Tier; reason: string }[] = [];
  presentFilesCalled = false;
  private pendingReason: string | undefined;
  private lastFailureTool: string | undefined;
  private failureStreak = 0;
  private seenCalls = new Map<string, number>();

  constructor(
    startTier: Tier,
    private readonly modelSupportsImages: (tier: Tier) => boolean,
    private readonly maxEscalations = 2,
  ) {
    this.tier = startTier;
  }

  observe(toolName: string, args: unknown, result: unknown): void {
    if (toolName === "present_files" && !isToolFailure(result)) this.presentFilesCalled = true;
    if (isToolFailure(result)) {
      this.failureStreak = this.lastFailureTool === toolName ? this.failureStreak + 1 : 1;
      this.lastFailureTool = toolName;
      if (this.failureStreak >= 2) this.flag(`工具 ${toolName} 连续失败 ${this.failureStreak} 次`);
    } else if (this.lastFailureTool === toolName) {
      this.failureStreak = 0;
      this.lastFailureTool = undefined;
    }
    if (!POLLING_TOOL.test(toolName)) {
      const key = `${toolName}:${stableJson(args)}`;
      const count = (this.seenCalls.get(key) ?? 0) + 1;
      this.seenCalls.set(key, count);
      if (count >= 2) this.flag(`以相同参数重复调用 ${toolName}`);
    }
    if (toolName !== "present_files" && resultHasImage(result) && !this.modelSupportsImages(this.tier)) {
      this.flag("需要看图，当前模型不支持图片");
    }
  }

  flag(reason: string) {
    this.pendingReason ??= reason;
  }

  /** 若有待处理的升档原因且还能升，返回新档位并记录。 */
  takeEscalation(): { fromTier: Tier; toTier: Tier; reason: string } | undefined {
    const reason = this.pendingReason;
    this.pendingReason = undefined;
    if (!reason || this.escalations.length >= this.maxEscalations) return undefined;
    const next = ModelRegistry.nextTier(this.tier);
    if (!next) return undefined;
    const record = { fromTier: this.tier, toTier: next, reason };
    this.escalations.push(record);
    this.tier = next;
    // 升档后重新计数，避免同一问题连续触发。
    this.failureStreak = 0;
    this.lastFailureTool = undefined;
    this.seenCalls.clear();
    return record;
  }

  canEscalate(): boolean {
    return this.escalations.length < this.maxEscalations && Boolean(ModelRegistry.nextTier(this.tier));
  }
}
