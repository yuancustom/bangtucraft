import { beforeEach, expect, it, vi } from "vitest";
import type { RunTrace } from "@drawing-agent/shared";
const state=vi.hoisted(()=>({subscribe:vi.fn()}));
vi.mock("react",()=>({useSyncExternalStore:(_subscribe:unknown,get:()=>unknown)=>get()}));
vi.mock("./api.ts",()=>({subscribeRun:state.subscribe}));
beforeEach(()=>{vi.resetModules();state.subscribe.mockReset().mockReturnValue(vi.fn());});

it("断线只显示重连，不把运行改失败；缓存过期后完整恢复持久化成果",async()=>{
  const {trackRun,useRuns}=await import("./runs-store.ts");
  trackRun("r1","t1","测试");
  const [,onEvent,,connection,recovered]=state.subscribe.mock.calls[0]!;
  onEvent({type:"status",status:"running",seq:1,at:1000});
  onEvent({type:"text",delta:"完成了一半",seq:2,at:1001});
  connection(true);
  expect(useRuns()[0]).toMatchObject({finished:false,status:"running",reconnecting:true});
  const trace={status:"completed",finalText:"完整结果",files:[{name:"model.html",path:"output/model.html",size:5,mediaType:"text/html"}]} as RunTrace;
  recovered(trace);
  const run=useRuns()[0]!;
  expect(run).toMatchObject({finished:true,status:"completed",reconnecting:false});
  expect(run.blocks).toEqual([{kind:"text",text:"完整结果"},{kind:"files",files:trace.files}]);
});
