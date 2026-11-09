# ADR 0001：执行循环用 Mastra Agent，而不是 createDurableAgent

- 日期：2026-11-06
- 状态：已采用

## 背景
计划 Task 3 写的是"Mastra Agent + createDurableAgent"，与原版一致。实现前读了已安装的 @mastra/core 1.69.0 文档（`dist/docs/references/reference-agents-durable-agent.md`、`docs-agents-human-in-the-loop.md`）。

## 发现
- DurableAgent 在 1.69 标注为 Beta。它的价值是"客户端断线后可重连同一个运行"，依赖 PubSub 与事件缓存。
- 函数形式的 `requireToolApproval`（按工具名和参数决定是否审批）在 DurableAgent 中只在同进程有效，跨进程恢复会退化成"所有工具都审批"。
- 普通 Agent 的 `approveToolCall` / `declineToolCall` / `resumeStream` 基于存储里的快照，接口清楚，测试里已验证批准、拒绝、ask_user 恢复都正常。

## 决定
用普通 `Agent.stream`，maxSteps 1000，其余配置（记忆、Observational Memory 阈值、Skill 按需加载、Workspace）与原版一致。"断线重连"由网关的 RunHub 承担：网关按 runId 缓存全部事件，浏览器 SSE 断开后带 `after=<seq>` 续传，刷新页面也能接上正在运行的轮次。

## 影响
- 与原版的差异只在运行包装层，Agent 循环本身相同。
- 服务进程重启后，挂起中的审批不会自动恢复（原版同样不自动恢复中断任务）；未结束的运行在重启时被标记为失败。
