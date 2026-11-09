# 帮帮图图：Windows + Docker

用户在 2026-11-09 选择混合部署，以保留 Windows 专用 DWG 转换和既有建模能力。

```text
内网浏览器 → Docker :18878（静态网页、Nginx SSE 代理）
                         → Windows :8787（Hono、账号、Agent Worker）
                               → 本地 Python / CAD 工具 / 搜索 MCP :8790
```

Docker 使用根目录 `compose.yaml` 和 `Dockerfile`。构建上下文采用允许列表，只发送前端、共享类型、依赖清单和 Nginx 配置；运行镜像没有 API key，也没有挂载 `.env`。Windows 执行端使用原 `data/`，升级和重建网页不会删除会话、图纸或模型。

从仓库根目录运行：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm -C apps/web build
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/Start-Agent.ps1
docker compose up -d --build
docker compose ps
```

新主机先填写 `.env` 和可选 `skills/local.json`。执行端需要 Node 24、uv、用户拥有的 Skills 和 CAD 工具；它们不从 GitHub 自动携带。搜索服务仍使用 `corepack pnpm searxng:up` 启动本机 SearXNG。

`deploy/Enable-Autostart.ps1` 可登记当前用户登录启动任务 `BangBangTuTu-Agent`，通过隐藏进程启动执行端。Docker Desktop 应开启登录启动。执行端日志和 PID 在 `data/windows-agent.*`。日志不提交。

访问入口为 `http://<Windows宿主机IPv4>:18878`。本机可以访问不代表另一台设备的防火墙和网络策略也允许访问；部署时需分别检查监听地址、容器健康和宿主机内网接口。IP 由所在网络分配，换网后可能变化。

上传代码前执行 `git add` 后运行 `corepack pnpm check:secrets`。`.env`、运行数据、真实验收截图、DWG、私有 Skill 副本、逆向材料均不提交。仅提交空值 `.env.example` 和通用配置示例。
