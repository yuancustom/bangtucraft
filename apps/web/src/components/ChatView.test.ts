import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  effects: [] as (() => unknown)[],
  scroll: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, vi.fn()],
  useRef: (initial: unknown) => ({ current: initial === null ? { scrollIntoView: fixture.scroll } : initial }),
  useMemo: (compute: () => unknown) => compute(),
  useEffect: (effect: () => unknown) => fixture.effects.push(effect),
}));
vi.mock("../runs-store.ts", () => ({ useRuns: () => [], trackRun: vi.fn() }));
vi.mock("../api.ts", () => ({ api: { history: async () => ({ messages: [] }) } }));

import { ChatView } from "./ChatView.tsx";

beforeEach(() => {
  fixture.effects.length = 0;
  fixture.scroll.mockReset();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
});

it.each([false, true])("scrollIntoView returns Promise=%s: effects only return React cleanup functions or undefined", (promise) => {
  fixture.scroll.mockImplementation(() => (promise ? Promise.resolve() : undefined));
  ChatView({ threadId: "test-thread", models: [], skills: [], onActivity: vi.fn() });
  for (const effect of fixture.effects) {
    const cleanup = effect();
    expect(cleanup === undefined || typeof cleanup === "function").toBe(true);
  }
  expect(fixture.scroll).toHaveBeenCalledWith({ behavior: "smooth" });
});
