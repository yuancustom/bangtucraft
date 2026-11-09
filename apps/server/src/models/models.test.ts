import { afterEach, describe, expect, it } from "vitest";
import { FAKE_SECRET, fakeModelsFile, startFakeOpenAI } from "../test-utils/fake-openai.ts";
import { Redactor } from "../redact.ts";
import { modelsFileSchema } from "./schema.ts";
import { ModelRegistry } from "./registry.ts";
import { discoverModels, streamChat } from "./openai-compat.ts";
import { EscalationTracker, claimsDeliveryWithoutFiles, parseComplexity, routeTask } from "./router.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

function registryFor(url: string) {
  const file = modelsFileSchema.parse({
    ...fakeModelsFile(url),
    models: fakeModelsFile(url).models.map((m) =>
      m.id === "fake-l1" ? { ...m, providerOptions: { reasoningEffort: "high", thinking: { type: "enabled" } } } : m,
    ),
  });
  return new ModelRegistry(file, { FAKE_API_KEY: FAKE_SECRET });
}

describe("models.json 校验", () => {
  it("引用未知接入点或未知角色模型时被拒绝", () => {
    const base = fakeModelsFile("http://x.test/v1");
    expect(modelsFileSchema.safeParse({ ...base, roles: { ...base.roles, judge: "nope" } }).success).toBe(false);
    expect(
      modelsFileSchema.safeParse({ ...base, models: base.models.map((m) => ({ ...m, provider: "ghost" })) }).success,
    ).toBe(false);
  });
});

describe("ModelRegistry", () => {
  it("生成 Mastra 模型配置、providerOptions 和成本估算", () => {
    const reg = registryFor("http://x.test/v1/");
    expect(reg.spec("fake-l1")).toEqual({ providerId: "fake", modelId: "fake-l1", url: "http://x.test/v1", apiKey: FAKE_SECRET });
    expect(reg.providerOptions("fake-l1")).toEqual({ fake: { reasoningEffort: "high", thinking: { type: "enabled" } } });
    expect(reg.providerOptions("fake-l2")).toBeUndefined();
    expect(reg.estimateCost("fake-l1", 1_000_000, 500_000)).toEqual({ cost: 2, currency: "CNY" });
    expect(ModelRegistry.nextTier("L1")).toBe("L2");
    expect(ModelRegistry.nextTier("L3")).toBeUndefined();
  });
});

describe("streamChat / discoverModels（本地假服务）", () => {
  it("用流式请求并带鉴权头，解析文本与用量", async () => {
    const fake = await startFakeOpenAI(() => ({ text: "pong-你好", usage: { prompt: 7, completion: 3 } }));
    close = fake.close;
    const result = await streamChat(registryFor(fake.url), new Redactor([FAKE_SECRET]), "fake-l1", [
      { role: "user", content: "ping" },
    ]);
    expect(result.text).toBe("pong-你好");
    expect(result.inputTokens).toBe(7);
    expect(fake.requests[0]!.headers.authorization).toBe(`Bearer ${FAKE_SECRET}`);
    expect(fake.requests[0]!.body.stream).toBe(true);
    expect(fake.requests[0]!.body.model).toBe("fake-l1");
  });

  it("HTTP 错误信息被脱敏", async () => {
    const fake = await startFakeOpenAI(() => ({ status: 401, errorBody: `bad key ${FAKE_SECRET}` }));
    close = fake.close;
    const error = await streamChat(registryFor(fake.url), new Redactor([FAKE_SECRET]), "fake-l2", [
      { role: "user", content: "x" },
    ]).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain(FAKE_SECRET);
  });

  it("列出接入点模型", async () => {
    const fake = await startFakeOpenAI(() => ({ text: "" }));
    close = fake.close;
    expect(await discoverModels(registryFor(fake.url), new Redactor(), "fake")).toEqual(["fake-a", "fake-b"]);
  });
});

describe("routeTask", () => {
  const reg = registryFor("http://x.test/v1");
  const deps = (complexity: "simple" | "standard" | "complex" | Error) => ({
    registry: reg,
    skillTiers: { "dwg-to-dxf": "L1" as const, "bangtu-arch-2d-to-3d": "L3" as const },
    classify: async () => {
      if (complexity instanceof Error) throw complexity;
      return complexity;
    },
  });
  const input = { text: "x", model: "auto", hasImages: false, skills: [] as string[] };

  it("按分类结果选档位，complex 先规划", async () => {
    expect((await routeTask(input, deps("simple"))).modelId).toBe("fake-l1");
    expect((await routeTask(input, deps("standard"))).modelId).toBe("fake-l2");
    const complex = await routeTask(input, deps("complex"));
    expect(complex.modelId).toBe("fake-l3");
    expect(complex.plan).toBe(true);
  });

  it("带图片的输入不会选到不支持图片的 L1", async () => {
    const d = await routeTask({ ...input, hasImages: true }, deps("simple"));
    expect(d.tier).toBe("L2");
    const manual = await routeTask({ ...input, hasImages: true, model: "fake-l1" }, deps("simple"));
    expect(manual.modelId).toBe("fake-l2");
  });

  it("用户指定模型时不分类、不规划", async () => {
    const d = await routeTask({ ...input, model: "fake-l3" }, deps(new Error("不应调用")));
    expect(d).toMatchObject({ modelId: "fake-l3", plan: false });
  });

  it("Skill 难度标注优先，分类失败回落 standard", async () => {
    expect((await routeTask({ ...input, skills: ["dwg-to-dxf"] }, deps("complex"))).tier).toBe("L1");
    expect((await routeTask({ ...input, skills: ["dwg-to-dxf", "bangtu-arch-2d-to-3d"] }, deps("simple"))).plan).toBe(true);
    expect((await routeTask(input, deps(new Error("down")))).tier).toBe("L2");
  });

  it("解析分类器输出", () => {
    expect(parseComplexity('{"tier":"complex"}')).toBe("complex");
    expect(parseComplexity("答案：simple")).toBe("simple");
    expect(() => parseComplexity("不知道")).toThrow();
  });
});

describe("EscalationTracker", () => {
  const images = (tier: string) => tier !== "L1";

  it("同一工具连续失败 2 次触发升档，最多 2 次、最高 L3", () => {
    const t = new EscalationTracker("L1", images);
    t.observe("local_command_execute", { command: "a" }, { success: false, exitCode: 1 });
    expect(t.takeEscalation()).toBeUndefined();
    t.observe("local_command_execute", { command: "b" }, { success: false, exitCode: 1 });
    expect(t.takeEscalation()).toMatchObject({ fromTier: "L1", toTier: "L2" });
    t.observe("x", { a: 1 }, { ok: true });
    t.observe("x", { a: 1 }, { ok: true });
    expect(t.takeEscalation()).toMatchObject({ fromTier: "L2", toTier: "L3" });
    t.observe("y", {}, { success: false });
    t.observe("y", {}, { success: false });
    expect(t.takeEscalation()).toBeUndefined();
    expect(t.tier).toBe("L3");
  });

  it("轮询类工具重复调用不算原地打转；看图触发升档", () => {
    const t = new EscalationTracker("L1", images);
    t.observe("bangtu_get_task_status", { taskId: "1" }, { status: "RUNNING" });
    t.observe("bangtu_get_task_status", { taskId: "1" }, { status: "RUNNING" });
    expect(t.takeEscalation()).toBeUndefined();
    t.observe("present_files", { paths: ["a.dxf"] }, { success: true, files: [{ path: "a.dxf", mediaType: "image/vnd.dxf" }] });
    t.observe("present_files", { paths: ["a.png"] }, { success: true, files: [{ path: "a.png", mediaType: "image/png" }] });
    expect(t.takeEscalation()).toBeUndefined();
    t.observe("capture", {}, { content: [{ type: "image", mediaType: "image/png" }] });
    expect(t.takeEscalation()?.reason).toContain("看图");
  });

  it("声称交付但未调用 present_files", () => {
    expect(claimsDeliveryWithoutFiles("报告已生成，请查看。", false)).toBe(true);
    expect(claimsDeliveryWithoutFiles("报告已生成，请查看。", true)).toBe(false);
    expect(claimsDeliveryWithoutFiles("你好", false)).toBe(false);
  });
});
