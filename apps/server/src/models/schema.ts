import { z } from "zod";

export const tierSchema = z.enum(["L1", "L2", "L3"]);

export const providerSchema = z
  .object({
    id: z.string().min(1),
    baseUrl: z.url().optional(),
    baseUrlEnv: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1),
    /** 接入点只支持流式请求（CodeBuddy 拒绝非流式）。 */
    streamOnly: z.boolean().default(false),
    /** 是否经 HTTPS_PROXY 访问。 */
    useProxy: z.boolean().default(false),
  })
  .refine((p) => Boolean(p.baseUrl) !== Boolean(p.baseUrlEnv), { message: "baseUrl 与 baseUrlEnv 二选一" });

export const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  tier: tierSchema,
  capabilities: z.object({ tools: z.boolean(), images: z.boolean(), reasoning: z.boolean() }),
  contextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  pricePerMTokens: z.object({ input: z.number().min(0), output: z.number().min(0), currency: z.string().min(1) }),
});

const roleNames = ["L1", "L2", "L3", "classifier", "planner", "summarizer", "title", "judge"] as const;
export type RoleName = (typeof roleNames)[number];

export const modelsFileSchema = z
  .object({
    providers: z.array(providerSchema).min(1),
    models: z.array(modelSchema).min(1),
    roles: z.object(Object.fromEntries(roleNames.map((r) => [r, z.string().min(1)])) as Record<RoleName, z.ZodString>),
  })
  .superRefine((file, ctx) => {
    const providers = new Set(file.providers.map((p) => p.id));
    const models = new Set(file.models.map((m) => m.id));
    file.models.forEach((m, i) => {
      if (!providers.has(m.provider)) ctx.addIssue({ code: "custom", path: ["models", i, "provider"], message: "未知接入点" });
    });
    for (const role of roleNames) {
      if (!models.has(file.roles[role])) ctx.addIssue({ code: "custom", path: ["roles", role], message: "未知模型" });
    }
  });

export type ModelsFile = z.infer<typeof modelsFileSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
