# ADR 0003：用户隔离方式与边界

- 日期：2026-11-06
- 状态：已采用

## 决定
- 每个用户一个 Worker 子进程（`child_process.fork`），持有该用户自己的 Mastra 实例、`agent.db`（会话与记忆）、`app.db`（运行追踪）和 `workspace/`。
- 网关只按登录用户把请求转给对应 Worker；运行事件按 runId 登记归属，Worker 推来的事件若用户不匹配直接丢弃。
- 文件接口、工作空间工具都经过 `resolveWorkspacePath`：拒绝 `..` 越界、工作空间外绝对路径、经 junction / 符号链接逃逸（包括尚不存在的新文件的父目录）。
- HTML / SVG 成果以 `Content-Security-Policy: sandbox` 下发，前端用 `sandbox` iframe 预览，脚本拿不到本站 Cookie。

## 边界（不是什么）
- 这不是操作系统级沙箱。`local_command_execute` 运行的 PowerShell 以服务进程的 Windows 账户身份执行，能读写该账户可访问的任何文件、能联网。约束靠"请求批准"模式下的人工审批，与原版一致。
- 三个用户共用一台机器和一个 Windows 账户，适合本地可信小团队；若要对外开放，需要另行设计账户级或容器级隔离。
