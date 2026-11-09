# 帮帮图图（BangtuCraft）

面向建筑图纸理解的网页 Agent，采用单 Agent + Skills + MCP 架构。默认免登录进入共享的本地工作空间，也可配置最多 3 个独立账号。支持流式对话、工具审批与文件交付。新会话首轮成功问答后自动概括命名；手动名称保留。设计与进度见 `docs/01-plan.md`、`docs/adr/`。

## 首次准备

1. 复制 `.env.example` 为 `.env`，填好 `CODEBUDDY_API_KEY`、`OPENAI_API_KEY`、`SEARXNG_SECRET`（任意随机长串）。访问 GPT 中转站需要 `HTTPS_PROXY`。
2. 安装依赖：`corepack pnpm install`
3. 按需把 `skills/local.example.json` 复制为 `skills/local.json`，填写自己拥有的 Skill 目录。帮图专有 Skill 副本只供本机内部对比，不随代码或镜像分发。
4. 启动搜索服务（需要 Docker Desktop）：`corepack pnpm searxng:up`

## 运行

- 正式运行：`corepack pnpm start`，浏览器打开 http://127.0.0.1:8787 。会先构建前端，再启动服务和搜索 MCP。
- 开发模式：`corepack pnpm dev`，浏览器打开 http://127.0.0.1:5173 。
- 默认打开即用，无需注册或输入账号；内网访问者共享会话与文件。`.env` 的 `LOCAL_USER_ID` 可指定已有用户，保留其历史和模型；`AUTH_MODE=accounts` 可恢复独立账号模式。

## 本地 Docker 混合部署（Windows）

本机的 DWG 转换依赖 Windows 工具，因此 Docker 托管网页和反向代理，Agent、Python 与 CAD 执行端继续在 Windows 运行。容器不挂载 `.env`、原图、数据库或 Skills；登录、会话和文件仍使用宿主机 `data/`。

1. 按首次准备填写根目录 `.env`，确认 `HTTPS_PROXY` 是当前可用的宿主机代理地址。
2. 停止占用 8787/8790 的旧实例，执行 `powershell -NoProfile -ExecutionPolicy Bypass -File deploy/Start-Agent.ps1`，隐藏启动 Windows 执行端；日志和 PID 位于忽略提交的 `data/`。
3. 执行 `docker compose up -d --build`。打开 `http://localhost:18878`；同一内网使用 `http://<宿主机IPv4>:18878`，直接进入原工作空间。
4. 需要登录后自启时执行 `powershell -NoProfile -ExecutionPolicy Bypass -File deploy/Enable-Autostart.ps1`。Docker Desktop 自身需开启登录启动，容器配置为 `unless-stopped`。

执行端监听 8787，Docker 通过 `host.docker.internal` 访问它。反向代理保留 Host/Origin，关闭 SSE 缓冲，支持 200MB 上传。可用进程环境变量 `BANGTUTU_PORT` 改 Docker 入口端口。`docker compose ps` 查看健康状态；`docker compose down` 只停止网页容器，不删除 Windows 数据。

Windows 执行端启动命令只在子进程内设置监听地址，不改写 `.env`。本机部署信息见 `docs/deployment.md`。容器无法直接运行 Windows `.exe`，这是采用混合部署的原因。

## 测试

- `corepack pnpm test`：单元与集成测试，全部使用本地假模型、假 MCP，不联网、不花钱。
- `corepack pnpm typecheck`、`corepack pnpm lint`
- `corepack pnpm check:secrets`：提交前扫描暂存区确切内容，检查已配置密钥、常见凭据格式及私有文件；输出不包含密钥值。
- 真实冒烟（会调用真实模型，少量费用）：`node scripts/smoke.mjs "问题" auto request`、`node scripts/smoke-compare.mjs general-intro`

## 目录

- `apps/server`：网关（Hono）、每用户 Worker、Mastra Agent、工具、对比模块
- `apps/web`：React 前端
- `packages/shared`：前后端协议类型
- `packages/search-mcp`：SearXNG 的 MCP 包装与 docker-compose
- `config/`：模型与角色（`models.json`）、Skill 难度（`skill-tiers.json`）、MCP 服务（`mcp.json`）
- `skills/`：自研 Skill（`own/`）、用户自有 Skill 登记（`local.json`）、帮图副本（`vendor-bangtu/`，不进 git）
- `evals/cases/`：评测用例
- `data/`：运行数据（每用户的工作空间、会话库、追踪库），不进 git
