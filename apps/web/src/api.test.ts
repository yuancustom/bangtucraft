import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { subscribeRun } from "./api.ts";

class FakeSource {
  static instances: FakeSource[] = [];
  onopen?: () => void;
  onerror?: () => Promise<void>;
  listeners = new Map<string, (event: { data: string }) => void>();
  close = vi.fn();
  constructor(readonly url: string) { FakeSource.instances.push(this); }
  addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, listener); }
  emit(seq: number, type = "text") { this.listeners.get("run")?.({ data: JSON.stringify({ runId: "r1", seq, at: 1, type, delta: "片段" }) }); }
}
const latest = () => FakeSource.instances.at(-1)!;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.instances = [];
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockRejectedValue(new TypeError("入口暂不可用"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("Docker入口长时间中断仍持续重连，不把后台任务判失败，按seq续传且不重复", async () => {
  const seen = vi.fn(), gone = vi.fn(), connection = vi.fn();
  const stop = subscribeRun("r1", seen, gone, connection);
  latest().emit(7);
  for (let i = 0; i < 12; i++) {
    await latest().onerror!();
    await vi.advanceTimersByTimeAsync(10000);
  }
  expect(FakeSource.instances).toHaveLength(13);
  expect(latest().url).toContain("after=7");
  expect(gone).not.toHaveBeenCalled();
  latest().onopen!();
  latest().emit(7); latest().emit(8); latest().emit(9, "done");
  expect(seen.mock.calls.map(([event]) => event.seq)).toEqual([7, 8, 9]);
  expect(connection).toHaveBeenLastCalledWith(false);
  await vi.advanceTimersByTimeAsync(60000);
  expect(FakeSource.instances).toHaveLength(13);
  stop();
});

it("503仍重连，只有执行端明确404才终止订阅", async () => {
  const gone = vi.fn();
  fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({error:"运行不存在或已过期"}), { status: 404 }));
  subscribeRun("r1", vi.fn(), gone);
  await latest().onerror!(); await vi.advanceTimersByTimeAsync(10000);
  expect(gone).not.toHaveBeenCalled();
  await latest().onerror!(); await vi.advanceTimersByTimeAsync(60000);
  expect(gone).toHaveBeenCalledOnce();
  expect(FakeSource.instances).toHaveLength(2);
});

it("事件缓存过期时恢复持久化成果，不当成任务失败", async () => {
  const recovered = vi.fn(), gone = vi.fn();
  const trace = { runId: "r1", status: "completed", finalText: "完成", files: [{ path: "out/model.html" }] };
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ trace })));
  subscribeRun("r1", vi.fn(), gone, vi.fn(), recovered);
  await latest().onerror!();
  expect(recovered).toHaveBeenCalledWith(trace);
  expect(gone).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60000);
  expect(FakeSource.instances).toHaveLength(1);
});

it("取消订阅后，迟到的状态响应不再触发恢复或重试", async () => {
  let resolve!: (value: Response) => void;
  fetchMock.mockImplementation(() => new Promise<Response>(r => { resolve = r; }));
  const gone = vi.fn();
  const stop = subscribeRun("r1", vi.fn(), gone);
  const pending = latest().onerror!();
  stop(); resolve(new Response(JSON.stringify({error:"运行不存在或已过期"}), { status: 404 })); await pending;
  await vi.advanceTimersByTimeAsync(60000);
  expect(gone).not.toHaveBeenCalled();
  expect(FakeSource.instances).toHaveLength(1);
});

it("代理或旧网关的默认404不代表任务丢失",async()=>{
  const gone=vi.fn();
  fetchMock.mockResolvedValue(new Response("404 Not Found",{status:404}));
  const stop=subscribeRun("r1",vi.fn(),gone);
  await latest().onerror!(); await vi.advanceTimersByTimeAsync(10000);
  expect(gone).not.toHaveBeenCalled(); expect(FakeSource.instances).toHaveLength(2);
  stop();
});
