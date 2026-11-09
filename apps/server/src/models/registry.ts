import type { ModelInfo, Tier } from "@drawing-agent/shared";
import type { ModelConfig, ModelsFile, ProviderConfig, RoleName } from "./schema.ts";

/** Mastra 可直接接受的 OpenAI 兼容模型配置。 */
export interface MastraModelSpec {
  providerId: string;
  modelId: string;
  url: string;
  apiKey: string;
}

const TIERS: Tier[] = ["L1", "L2", "L3"];

export class ModelRegistry {
  private readonly models = new Map<string, ModelConfig>();
  private readonly providers = new Map<string, ProviderConfig>();

  constructor(
    readonly file: ModelsFile,
    private readonly secrets: Record<string, string>,
  ) {
    for (const p of file.providers) this.providers.set(p.id, p);
    for (const m of file.models) this.models.set(m.id, m);
  }

  list(): ModelInfo[] {
    return this.file.models.map((m) => ({
      id: m.id,
      name: m.name,
      tier: m.tier,
      provider: m.provider,
      capabilities: m.capabilities,
    }));
  }

  get(id: string): ModelConfig {
    const model = this.models.get(id);
    if (!model) throw new Error(`未知模型：${id}`);
    return model;
  }

  has(id: string): boolean {
    return this.models.has(id);
  }

  role(role: RoleName): ModelConfig {
    return this.get(this.file.roles[role]);
  }

  forTier(tier: Tier): ModelConfig {
    return this.role(tier);
  }

  /** 比给定档位高一档；已是 L3 时返回 undefined。 */
  static nextTier(tier: Tier): Tier | undefined {
    return TIERS[TIERS.indexOf(tier) + 1];
  }

  static tierAtLeast(tier: Tier, min: Tier): Tier {
    return TIERS.indexOf(tier) >= TIERS.indexOf(min) ? tier : min;
  }

  baseUrl(providerId: string): string {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`未知接入点：${providerId}`);
    const url = provider.baseUrl ?? this.secrets[provider.baseUrlEnv!];
    if (!url) throw new Error(`接入点 ${providerId} 缺少地址`);
    return url.replace(/\/+$/, "");
  }

  provider(providerId: string): ProviderConfig {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`未知接入点：${providerId}`);
    return provider;
  }

  apiKey(providerId: string): string {
    const provider = this.provider(providerId);
    const key = this.secrets[provider.apiKeyEnv];
    if (!key) throw new Error(`接入点 ${provider.id} 缺少密钥（${provider.apiKeyEnv}）`);
    return key;
  }

  spec(modelId: string): MastraModelSpec {
    const model = this.get(modelId);
    const provider = this.provider(model.provider);
    const apiKey = this.secrets[provider.apiKeyEnv];
    if (!apiKey) throw new Error(`接入点 ${provider.id} 缺少密钥（${provider.apiKeyEnv}）`);
    return { providerId: provider.id, modelId: model.id, url: this.baseUrl(provider.id), apiKey };
  }

  /** Mastra providerOptions：按接入点 ID 命名空间放置。 */
  providerOptions(modelId: string): Record<string, Record<string, unknown>> | undefined {
    const model = this.get(modelId);
    return model.providerOptions ? { [model.provider]: model.providerOptions } : undefined;
  }

  estimateCost(modelId: string, inputTokens: number, outputTokens: number): { cost: number; currency: string } {
    const price = this.get(modelId).pricePerMTokens;
    return {
      cost: (inputTokens * price.input + outputTokens * price.output) / 1_000_000,
      currency: price.currency,
    };
  }
}
