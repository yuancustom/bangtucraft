import { beforeEach, expect, it, vi } from "vitest";
import type { RunView } from "../run-state.ts";

const fixture = vi.hoisted(() => ({
  effects: [] as (() => unknown)[],
  scroll: vi.fn(),
  runs: [] as RunView[],
  send: vi.fn(),
  answer: vi.fn(),
  history: vi.fn(),
  cells: [] as unknown[],
  cursor: 0,
  uploading: false,
  files: [] as {path:string;name:string;image:boolean}[],
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = fixture.cursor++;
    if (!(i in fixture.cells)) fixture.cells[i] = typeof initial === "function" ? initial() : initial;
    return [fixture.cells[i], (value: unknown) => { fixture.cells[i] = typeof value === "function" ? value(fixture.cells[i]) : value; }];
  },
  useRef: (initial: unknown) => {
    const i = fixture.cursor++;
    if (!(i in fixture.cells)) fixture.cells[i] = { current: initial === null ? { scrollIntoView: fixture.scroll } : initial };
    return fixture.cells[i];
  },
  useMemo: (compute: () => unknown) => compute(),
  useEffect: (effect: () => unknown) => fixture.effects.push(effect),
}));
vi.mock("../runs-store.ts", () => ({ useRuns: () => fixture.runs, trackRun: vi.fn() }));
vi.mock("../api.ts", () => ({ api: { history: fixture.history,send:fixture.send,answer:fixture.answer } }));
vi.mock("../use-uploads.ts",async(original)=>({
  ...await original<typeof import("../use-uploads.ts")>(),
  useUploads:()=>({files:fixture.files,uploading:fixture.uploading,isUploading:()=>fixture.uploading,clear:vi.fn(),remove:vi.fn(),upload:vi.fn()}),
}));

import { ChatView } from "./ChatView.tsx";

beforeEach(() => {
  fixture.effects.length = 0;
  fixture.cells = [];
  fixture.cursor = 0;
  fixture.history.mockReset().mockResolvedValue({messages:[]});
  fixture.scroll.mockReset();
  fixture.runs=[];
  fixture.files=[];
  fixture.uploading=false;
  fixture.send.mockReset().mockResolvedValue({runId:"new-run"});
  fixture.answer.mockReset().mockResolvedValue({ok:true});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
});

interface TestElement {type:unknown;props:{children?:unknown;[key:string]:unknown}}
function findRun(node: unknown): TestElement | undefined {
  if (Array.isArray(node)) return node.map(findRun).find(Boolean);
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const el = node as TestElement;
  if (typeof el.type === "function" && el.type.name === "RunPanel") return el;
  return findRun(el.props.children);
}
const render = () => { fixture.cursor = 0; fixture.effects = []; return ChatView({threadId:"test-thread",models:[],skills:[],onActivity:vi.fn()}); };

it("刷新恢复的旧轮次结束后仍保留完整回复及成果面板", async () => {
  fixture.runs = [{runId:"restored",threadId:"test-thread",prompt:"旧任务",startedAt:Date.now()-60000,status:"running",finished:false,models:[],blocks:[]}];
  render();
  fixture.effects[0]!();
  await Promise.resolve();
  fixture.runs = [{...fixture.runs[0]!,status:"completed",finished:true,blocks:[{kind:"text",text:"成果已生成"}]}];
  expect((findRun(render())!.props.run as RunView).blocks).toEqual([{kind:"text",text:"成果已生成"}]);
});

it("加载历史时已完成的轮次不重复显示；离开会话后迟到的历史响应不写入", async () => {
  fixture.runs = [{runId:"old",threadId:"test-thread",prompt:"旧任务",startedAt:0,status:"completed",finished:true,models:[],blocks:[]}];
  render(); fixture.effects[0]!(); await Promise.resolve();
  expect(findRun(render())).toBeUndefined();
  let complete!: (value: unknown) => void;
  fixture.history.mockImplementation(() => new Promise(resolve => {complete=resolve;}));
  render(); const cleanup = fixture.effects[0]!() as () => void;
  cleanup();
  complete({messages:[{id:"late",role:"assistant",parts:[{type:"text",text:"迟到历史"}],createdAt:new Date().toISOString()}]});
  await Promise.resolve();
  expect(JSON.stringify(render())).not.toContain("迟到历史");
});
function findButton(node:unknown,label:string):TestElement|undefined {
  if(Array.isArray(node))return node.map(n=>findButton(n,label)).find(Boolean);
  if(!node||typeof node!=="object"||!("props" in node))return undefined;
  const el=node as TestElement;
  if(el.type==="button"&&el.props.children===label)return el;
  return findButton(el.props.children,label);
}

it("等待补充材料时，正文输入框中的附件发送给原问题并继续同一轮",async()=>{
  fixture.files=[{path:"uploads/补充.pdf",name:"补充.pdf",image:false}];
  fixture.runs=[{runId:"waiting-run",threadId:"test-thread",status:"waiting_input",finished:false,models:[],blocks:[{kind:"question",toolCallId:"q1",question:"上传PDF",allowFreeText:true,allowMultiple:false}],prompt:"请识图",startedAt:Date.now()}];
  const button=findButton(ChatView({threadId:"test-thread",models:[],skills:[],onActivity:vi.fn()}),"补充并继续")!;
  expect(button.props.disabled).toBe(false);
  (button.props.onClick as ()=>void)();
  expect(fixture.answer).toHaveBeenCalledWith("waiting-run","q1",[],"[附件] uploads/补充.pdf");
  expect(fixture.send).not.toHaveBeenCalled();
});

it("上传中即使触发旧发送事件，也不会提交不完整的附件列表",()=>{
  fixture.files=[{path:"uploads/已有.csv",name:"已有.csv",image:false}];
  fixture.uploading=true;
  const button=findButton(ChatView({threadId:"test-thread",models:[],skills:[],onActivity:vi.fn()}),"发送")!;
  expect(button.props.disabled).toBe(true);
  (button.props.onClick as ()=>void)();
  expect(fixture.send).not.toHaveBeenCalled();
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
