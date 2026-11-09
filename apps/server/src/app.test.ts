import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

describe("app", () => {
  it("GET /health 返回 ok", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
