// 测试用假 Worker：遵循 gateway/protocol.ts 的 IPC 协议。
import { getHeapStatistics } from "node:v8";
let userId = "";
process.on("message", (m) => {
  if (m.type === "init") {
    userId = m.userId;
    process.send({ type: "ready" });
    return;
  }
  if (m.type !== "request") return;
  const reply = (result) => process.send({ type: "response", id: m.id, ok: true, result });
  switch (m.method) {
    case "activeRuns":
      return reply({ execArgv: process.execArgv, heapLimit: getHeapStatistics().heap_size_limit });
    case "listThreads":
      return reply([{ id: `t-${userId}`, title: userId, createdAt: "", updatedAt: "" }]);
    case "startRun": {
      const [, , runId] = m.params;
      reply(null);
      let i = 0;
      const timer = setInterval(() => {
        i++;
        process.send({ type: "event", runId, body: { type: "text", delta: `${userId}-${i}` } });
        if (i === 3) {
          clearInterval(timer);
          process.send({ type: "event", runId, body: { type: "done", finishReason: "stop" } });
        }
      }, 20);
      return;
    }
    case "trace":
      return process.exit(7);
    default:
      return process.send({ type: "response", id: m.id, ok: false, error: `unknown ${m.method}` });
  }
});
