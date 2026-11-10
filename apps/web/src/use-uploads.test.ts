import {beforeEach, expect, it, vi} from "vitest";

const state = vi.hoisted(() => ({cells:[] as unknown[],cursor:0,upload:vi.fn()}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const i=state.cursor++;
    if (!(i in state.cells)) state.cells[i]=initial;
    return [state.cells[i], (next: unknown) => {state.cells[i]=typeof next==="function"?next(state.cells[i]):next;}];
  },
  useRef: (initial: unknown) => {
    const i=state.cursor++;
    if (!(i in state.cells)) state.cells[i]={current:initial};
    return state.cells[i];
  },
}));
vi.mock("./api.ts", () => ({api:{upload:state.upload}}));
import {attachmentText, isVisionImage, useUploads} from "./use-uploads.ts";
const render = (onError=vi.fn()) => {state.cursor=0;return useUploads(onError);};
beforeEach(() => {state.cells=[];state.upload.mockReset();});

it("上传未完成时阻止发送；上传后编辑正文不会丢失附件，移除后不再发送",async()=>{
  let complete!: (value:unknown)=>void;
  state.upload.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  let hook=render();
  const pending=hook.upload([new File(["data"],"表格.csv")]);
  expect(hook.isUploading()).toBe(true);
  hook=render(); expect(hook.uploading).toBe(true); expect(hook.files).toEqual([]);
  complete({path:"uploads/表格.csv",size:4}); await pending;
  hook=render(); expect(hook.uploading).toBe(false);
  expect(attachmentText("重新编辑的需求",hook.files)).toBe("重新编辑的需求\n[附件] uploads/表格.csv");
  expect(attachmentText("",hook.files)).toContain("[附件]");
  hook.remove("uploads/表格.csv"); expect(render().files).toEqual([]);
});

it("单个文件失败时保留其他成功附件，错误可见且能重传同名文件",async()=>{
  const onError=vi.fn();
  state.upload.mockRejectedValueOnce(new Error("连接中断")).mockResolvedValue({path:"uploads/成功.csv",size:2});
  await render(onError).upload([new File(["bad"],"失败.csv"),new File(["ok"],"成功.csv")]);
  expect(onError).toHaveBeenCalledWith("失败.csv：连接中断");
  expect(render().files).toHaveLength(1);
  state.upload.mockResolvedValue({path:"uploads/失败.csv",size:3});
  await render().upload([new File(["bad"],"失败.csv")]);
  expect(render().files).toHaveLength(2);
});

it("DWG/DXF 不作为视觉图片发送；普通图片传给视觉模型",()=>{
  expect(isVisionImage({name:"平面.dwg",type:"image/vnd.dwg"})).toBe(false);
  expect(isVisionImage({name:"平面.dxf",type:"image/vnd.dxf"})).toBe(false);
  expect(isVisionImage({name:"平面.PNG",type:""})).toBe(true);
});

it("拒绝超过100MiB的文件，超过8张图片不静默丢弃",async()=>{
  const onError=vi.fn();
  state.upload.mockImplementation(async(file:File)=>({path:`uploads/${file.name}`,size:file.size}));
  await render(onError).upload([{name:"large.dwg",size:100*1024*1024+1} as File]);
  expect(state.upload).not.toHaveBeenCalled();
  await render(onError).upload(Array.from({length:9},(_,i)=>new File(["png"],`${i}.png`)));
  expect(render().files).toHaveLength(8);
  expect(onError).toHaveBeenLastCalledWith("8.png：每次最多上传 8 张图片");
});
