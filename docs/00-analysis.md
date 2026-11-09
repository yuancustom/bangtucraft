# 帮图Mind 1.0.2 逆向分析

分析对象：d:\Code\bangtu\bangtuMind-setup.exe（298 MiB）。解包产物在 _extract\（只读）。

## 1. 打包与框架
- 安装包：electron-builder 生成的 NSIS-3 Unicode 安装器，主体是 $PLUGINSDIR\app-64.7z，另带 vc_redist。
- 桌面框架：Electron 40.10.6（Node 24.15）+ electron-vite + Vue 3 + shadcn-vue + Tailwind 4。
- Agent 框架：Mastra（@mastra/core 1.69、@mastra/memory 1.31、@mastra/libsql 1.23、@mastra/mcp 2.1、@mastra/observability）。
- 进程模型：Main（窗口、IPC、文件授权）+ Utility Process Worker（跑 Agent）+ Renderer（Vue）。
- 存储：本地 LibSQL，userData\data\bangtu.db（线程、消息、workflow 快照、Observational Memory、trace spans）。
- 开发文档留在 app.asar 里：docs/agent-architecture.md、docs/project-structure.md、tasks/*.md，设计意图写得很全。

## 2. 模型
- 配置：config.json 里 model = { providerId: "deepseek", modelId: "deepseek-flash" }。
- 地址：构建时注入 MODEL_BASE_URL = https://ai-gateway.bangtu-ai.com/ai/v1（OpenAI 兼容网关）。
- DeepSeek 专用参数：thinking.type = enabled，reasoningEffort = high。
- 凭据：登录 product.bangtu-ai.com 得到 Bearer token，同时当作模型网关 apiKey 和帮图 MCP apiKey。token 用 Electron safeStorage（Windows DPAPI）加密存在 userData\auth\session.json。请求头带 X-Message-Id = runId。

## 3. Agent 循环
- 单 Agent（id: bangtu-agent，名称"帮图Mind"），用 createDurableAgent 包装。没有 planner，没有多 Agent。
- 每轮：agent.stream(input, { maxSteps: 1000, requireToolApproval, memory: { thread, resource }, requestContext })。
- 远端异步任务（创建→等待→查询）全靠模型按 Skill 说明自己调工具推进，应用不在工具内部隐藏轮询。
- 审批和 ask_user 用 workflow 的 suspend / resume 实现。
- 记忆：lastMessages = 1000；Observational Memory 在原文 512000 token 时触发观察摘要，摘要 10000 token 时触发反思精简，同步执行（bufferTokens: false），scope = thread。
- 系统提示词：完整文本在 _extract\asar\out\main\chunks\index-CNznvYuh.js 第 684–770 行（中文，涵盖 MCP 通用规则、Skill 选择、后台任务等待、ask_user、附件、工作空间、Python 环境、联网搜索、present_files 交付规则）。

## 4. 工具
- 本地工具：ask_user、present_files、local_command_execute（PowerShell，LocalSandbox isolation: none，超时 1–120 秒）、local_file_stat / local_directory_list / local_file_read（工作空间外只读）、8 个 Mastra Workspace 原生文件工具（read/write/edit/list/delete/stat/mkdir/grep，contained: true）、python_runtime_status、install_binary、python_install_packages（uv + 清华 PyPI 镜像，只装 wheel，按 Skill 独立环境）。
- Skill 工具：Mastra 原生 skill / skill_read / skill_search，按需加载（上下文里只放名称和描述）。
- 审批规则：只审批工作空间外文件访问和未加载 Skill 时的命令；本轮加载过 Skill 后该流程的命令免审批；完全访问模式全部免审批。授权规则写在 userData\permissions.json。

## 5. MCP
配置在 config.json 的 mcpServers：
- bangtu-mcp：https://mcp.bangtu-ai.com/mcp（需要 apiKey，按调用计费）
- bangtu-search：https://searxng-mcp.bangtu-ai.com/mcp（search_web / search_images / search_videos / search_news / fetch_url）

接入方式：listToolsetsWithErrors 发现工具，不加前缀；schema 里声明的 apiKey 和 messageId 由宿主注入并从模型可见 schema 中剥离；输出脱敏；工具目录缓存 5 分钟，失败冷却 30 秒。

帮图 MCP 工具与价格（来自 https://mcp.bangtu-ai.com）：

| 价格 | 工具 |
|---|---|
| 免费 | bangtu_create_dwg_task、bangtu_create_electrical_pre_task、bangtu_create_hvac_pre_task、bangtu_get_task_status、bangtu_wait_task、bangtu_get_frame_result、bangtu_get_cv_result、bangtu_get_{electrical,hvac,plumbing,structure}_subframe_result |
| 1 币 / 图框 | bangtu_create_{architecture,structure,electrical,hvac,plumbing}_task |
| 0.05 币 | bangtu_get_frame_entities_download_url |
| 0.01 币 | bangtu_capture_screenshot_in_frame |

接口要点（来自 Skill 的 references/bangtu-api.md）：
- create_dwg_task：fileBase64+fileName / fileUrl / filePath 三选一，远程服务读不到本机路径，实际用 Base64。
- get_frame_result：返回 frameId、signInfo（图签）、frameWcsLoc、layoutName。
- get_cv_result：apiKey、product（必填，architecture / structure / electrical / hvac / plumbing）、taskId、dataType（planRoom、planDoor、planWindow、planStair、planLift、texts、axisNumber、textelvation、arrows、alignedDims、subFrame 等）。plan* 类结果包在 data.data[i].object[] 里，texts 等直接是 data.data[]。
- get_frame_entities_download_url：返回 30 分钟有效的 gzip JSON 链接，按 AcDbLine / AcDbPolyline / AcDbText / AcDbArc / AcDbCircle / AcDbBlockReference / AcDbHatch / AcDbAlignedDimension / AcDbAttribute 分组。
- 响应可能是 text/event-stream，取 data: 行拼接再解析；限流码 429 / 500003 / 2068 需退避；2021 表示结果过期。

## 6. Skills
resources/skills 下 24 个业务 Skill，约 480 个 Python 脚本，覆盖三维建模（建筑/结构/给排水/暖通/电气）、算量、规范审查、设计计算、图纸目录与检索、图纸比对。
- 脚本通过环境变量 BANGTU_MCP_URL / BANGTU_API_KEY 直接以 JSON-RPC 调帮图 MCP，绕过 Agent。
- 11 个 Skill 调用 PowerShell；bangtu-fire-alarm-system-design、bangtu-power-distribution-system-list、bangtu-dwg-frame-screenshot 依赖本机 AutoCAD accoreconsole.exe。
- 有 3 个 Skill 的 description 超过 Mastra 1024 字符上限，原版测试里加载失败，复刻时要核实。
- 帮图 Skill 是其专有内容，只用于内部对比，不随产品分发。

## 7. 可直接借鉴的设计
- 多会话隔离：前端按 conversationId 管理运行状态，runId → threadId 映射，迟到事件按 runId 丢弃。
- MCP 凭据注入与脱敏、工具目录缓存与故障隔离。
- 按 Skill 隔离的 Python 环境与依赖安装审批。
- present_files 成果交付规则（最终一次性汇总、只交付真实存在的文件）。
