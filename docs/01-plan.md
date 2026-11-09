# 实施计划：图纸理解网页 Agent 平台

## 问题
参照帮图Mind 的单 Agent + Skills + MCP 架构，做一个独立的网页端 Agent 平台：本地 Windows 部署，最多 3 个用户，每个用户独立工作空间、可开多个会话；按任务难度自动在 DeepSeek 和 GPT 之间选模型；图纸能力以自研为主，帮图云端只作可选对照；能与原版帮图Mind 做效果对比。

## 已确认的需求
- 部署：本地 Windows，≤3 人，只考虑 Windows。
- 隔离：每用户独立工作目录 + 独立 Worker 子进程 + 独立数据库。2026-11-09 用户确认改为混合部署：Docker 网页入口 + Windows Agent 执行端，保留 Windows CAD 工具。
- 产品独立：尽量自研平台和图纸 MCP，不依赖帮图。帮图云端只在少量图框上作对照答案，且受预算硬上限控制。
- 原版软件保持原样，不改它的配置。对比时用户在原版软件里手动开新对话，复刻版只读导入原版 bangtu.db。
- 执行顺序：先做完阶段一（通用 Agent），再做阶段二（自研图纸 MCP）。
- 测试图纸：E:\Code\tuzhilijie\samples\M1478Z02J试验厂房施工图_t3.dwg（建筑图）。

## 模型与路由
强弱排序：GPT astra > GPT sol > DeepSeek。

| 档位 | 模型 | 接入 | 用途 |
|---|---|---|---|
| L1 | deepseek-v4-flash（DeepSeek V4.1 Flash，100 万上下文，输出 65536，支持工具和推理，不支持图片） | CodeBuddy：https://www.codebuddy.cn/v2/chat/completions，key 在 CODEBUDDY_API_KEY | 简单问答、执行已确定步骤、标题、摘要、难度分类 |
| L2 | GPT sol（模型 ID 待查） | OpenAI 兼容中转：https://myboot.xyz/v1，key 在 OPENAI_API_KEY | 一般多步任务、按 Skill 执行 |
| L3 | GPT astra（模型 ID 待查） | 同上 | 复杂任务规划、失败诊断、看图、对比打分 |

路由规则：
1. 硬规则：输入含图片或需看截图 → 至少 L2；用户手动指定 → 按指定；Skill 注册表里标了难度 → 按标注（例如图签目录 L1，三维建模和规范审查 L3）。
2. 硬规则判断不了 → 用 L1 做一次短分类，输出 {"tier":"simple|standard|complex"}。
3. simple → L1 直接执行；standard → L2 直接执行；complex → L3 写计划，用户确认后 L2 或 L1 执行。
4. 运行中升档：同一工具连续失败 2 次、相同参数重复调用、未调用 present_files 就声称交付、子任务需要看图 → 剩余步骤升一档。最多到 L3，每轮最多升 2 次，升档原因写入运行记录。
5. 每个模型的单价写在配置里，每轮记录模型、token、估算成本。

## 技术栈
Node 24 + TypeScript + Mastra 1.69（与原版同版本）+ Hono（HTTP/SSE）+ React + Vite + shadcn/ui + LibSQL + vitest。图纸引擎用 Python 3.13（uv 管理）+ ezdxf + FastMCP + pytest。

## 架构

    浏览器 --HTTP/SSE--> 网关(Hono) --IPC--> 每用户 Worker(Mastra DurableAgent)
      Worker -> 模型路由 (planner / executor / summarizer / title / judge)
      Worker -> Skills (own / local / vendor-bangtu)
      Worker -> drawing-mcp（自研，gcmpDwgTools + ezdxf）
      Worker -> search-mcp（SearXNG）
      drawing-mcp -.可按工具切换.-> bangtu-proxy（缓存 + 预算）-> 帮图云端
      网关 -> 对比模块（只读导入原版 bangtu.db）

## 目录

    d:\Code\bangtu\
    ├─ bangtuMind-setup.exe       原版安装包，不动
    ├─ _extract\  _tools\         逆向分析产物，只读，不进 git
    ├─ AGENTS.md                  给 Codex 的项目说明
    ├─ docs\
    │  ├─ 00-analysis.md          原版结构分析
    │  ├─ 01-plan.md              本计划
    │  ├─ adr\                    架构决策记录，一项一文件
    │  └─ eval-reports\           每轮对比报告
    ├─ apps\
    │  ├─ server\                 Hono 网关 + 用户 Worker + Mastra Agent
    │  └─ web\                    React 前端
    ├─ packages\
    │  ├─ shared\                 前后端协议与类型
    │  ├─ drawing-mcp\            自研图纸 MCP（Python），与帮图接口兼容
    │  ├─ bangtu-proxy\           帮图云端缓存与预算代理（可选）
    │  └─ search-mcp\             SearXNG 的 MCP 包装 + docker-compose
    ├─ skills\
    │  ├─ own\                    自研 Skill，进 git
    │  ├─ local.json              引用 .codex-switcher 下用户自有 Skill 的路径，不复制
    │  └─ vendor-bangtu\          帮图 Skill 副本，仅对比用，不进 git
    ├─ config\models.json         模型、能力、单价、角色分配（不含密钥）
    ├─ evals\
    │  ├─ cases\*.yaml            评测用例
    │  └─ runs\                   运行追踪，不进 git
    ├─ data\                      运行数据，不进 git
    │  ├─ users\<uid>\workspace\  每用户工作空间
    │  ├─ users\<uid>\agent.db    每用户会话与记忆
    │  └─ cache\  ledger.json     帮图云端缓存与扣费账本
    └─ .env                       密钥，用户自己填，不进 git

## 任务

每个任务完成后：勾选、写验证结果、停下等用户确认。

### 阶段一：通用 Agent

- [x] **Task 1：仓库骨架**
  - 目标：按上面目录建 pnpm monorepo（apps/server、apps/web、packages/shared），配 TypeScript、ESLint、vitest。server 启动时读取 .env 和 config/，缺少变量时报出变量名但不打印值。
  - 测试：配置加载与校验单元测试（缺失、非法值被拒绝）。
  - 演示：`pnpm dev` 后浏览器能打开空白页，`/health` 返回 ok。
  - 验证结果（2026-11-06）：
    - `corepack pnpm test`：2 个文件 6 项通过（/health；合法配置与默认值；.env 读取与进程环境优先；缺失变量报全部变量名；非法值被拒且错误信息不含取值；models.json 缺失/损坏/结构非法被拒）。
    - `corepack pnpm typecheck`（3 个包）与 `corepack pnpm lint` 通过。
    - `corepack pnpm dev`：server 监听 127.0.0.1:8787，`/health` 返回 `{"status":"ok"}`；web 在 127.0.0.1:5173 返回 200，经 Vite 代理访问 `/health` 也返回 ok。
    - 说明：本机未全局安装 pnpm，统一用 `corepack pnpm`（锁定 pnpm 10.34.9）。config/models.json 目前是空骨架，Task 2 填充。

- [x] **Task 2：模型注册表、模型发现和难度路由**
  - 目标：接入 codebuddy（baseURL https://www.codebuddy.cn/v2，模型 deepseek-v4-flash，开启推理）和 apikeyfun（baseURL https://myboot.xyz/v1）两个 OpenAI 兼容接入点。先调 GET /v1/models 列出中转站可用模型，交给用户确认 astra 和 sol 的模型 ID，再写入 config/models.json（含能力和单价）。实现 router.ts：硬规则 → L1 分类 → 是否先规划；实现运行中升档。
  - 注意：OPENAI_API_KEY 用户提供的值可能被截断，连不通时先请用户核对。CodeBuddy 接口若需要额外请求头，以实际返回为准。
  - 测试：本地假 OpenAI 服务检查请求体（推理参数、鉴权头）和错误脱敏；固定样例任务的路由结果；模拟连续失败触发升档；带图片的输入不会选到 DeepSeek。
  - 演示：页面上 ping 三个模型；发三个难度不同的问题，显示所选模型和理由。
  - 验证结果（2026-11-06）：
    - 只读调用 GET /v1/models 查到中转站模型列表，确认 astra = `gpt-6-astra`、sol = `gpt-6.1-sol`（用户给的名字 6.1sol / 6astra 与列表一致），各发一次只回 ok 的请求均 200。OPENAI_API_KEY 可用，无需更换。
    - CodeBuddy 只接受流式请求（非流式返回 11101）；Mastra 的 OpenAI 兼容适配器本身走流式，已在真实调用中验证工具调用循环正常。GPT 中转站需要经 HTTPS_PROXY（127.0.0.1:12000）访问，CodeBuddy 直连；由 `network.ts` 按接入点自动加入 NO_PROXY。
    - `models/models.test.ts` 13 项通过：配置校验、Mastra 模型配置与 providerOptions、成本估算、假服务验证流式请求体与鉴权头、HTTP 错误脱敏、模型发现、四类路由规则（分类结果、图片不选 L1、手动指定、Skill 难度与分类失败回落）、升档（连续失败、重复调用、轮询类工具豁免、present_files 的文件元数据不算看图、最多 2 次）、未调用 present_files 却声称交付。
    - 真实运行：问候走 L1 deepseek-v4-flash；建文件 + 命令 + 交付走 L2 gpt-6.1-sol；复杂笔记任务走 L3 gpt-6-astra 规划。
    - 说明：`config/models.json` 里的单价是占位估算（人民币/百万 token），请按实际账单修改。

- [x] **Task 3：Agent 核心和流式对话**
  - 目标：用 Mastra Agent + createDurableAgent，系统提示词取自原版（docs/00-analysis.md 第 3 节所指位置），去掉帮图品牌和登录相关内容，按网页环境调整。maxSteps 1000；Memory：lastMessages 1000，Observational Memory 512000 / 10000 阈值，scope thread，摘要用 L1。POST /api/sessions/:id/messages 用 SSE 推送 text / reasoning / tool-call / tool-result / done / error。前端做单会话聊天、Markdown 渲染、可折叠思考区。
  - 测试：假模型驱动多步工具循环，验证事件顺序、停止、出错路径。
  - 演示：网页上和 DeepSeek 对话，能看到思考过程。
  - 验证结果（2026-11-06）：
    - 偏离计划：未使用 createDurableAgent，改用普通 Mastra Agent，原因与影响见 `docs/adr/0001-agent-not-durable.md`。其余配置与原版一致：maxSteps 1000、lastMessages 1000、Observational Memory 512000 / 10000、scope thread、同步压缩，摘要与标题用 L1。系统提示词改写自原版通用规则（`agent/instructions.ts`）。
    - 全量 `corepack pnpm test` 9 个文件 63 项通过，typecheck 与 lint 通过。
    - `agent/runtime.test.ts` 10 项通过（假模型驱动）：密钥不落库；简单对话的事件顺序与历史、追踪落库；命令批准后执行；拒绝批准后模型收到拒绝说明；ask_user 挂起与恢复；连续失败升档；规划→确认→执行；拒绝计划；中途停止；模型报错时失败且脱敏。
    - 自查发现并修复：Mastra 会把 Observational Memory 的配置写进 `agent.db`，模型以对象传入时 apiKey 也被写了进去。改为以函数提供模型后不再落库，新增回归测试扫描会话库全部表与列；已用 `scripts/scrub-secrets.mjs` 清理冒烟期间写入的 7 处并 VACUUM，复查 data/ 下无残留。
    - 真实运行：`scripts/smoke.mjs` 与 DeepSeek 对话，事件流 status→route→model→text→usage→done 正常。CodeBuddy 的 deepseek-v4-flash 即使传了 thinking 参数也没有返回 reasoning_content，所以 DeepSeek 下思考区可能为空；界面在模型返回思考时显示可折叠思考区。
    - 补充实测（2026-11-08）：实际网页在当前浏览器中因滚动 effect 隐式返回 Promise 而白屏，已改为不返回滚动调用结果，并新增 2 项回归测试。全量 10 文件 65 项测试、typecheck、lint、生产构建通过。直接操作正式网页、调用真实 DeepSeek / Sol / Astra 完成 7 轮使用测试，覆盖连续对话、HTML/CSV 交付、真实 DWG 转换和文字坐标识读；仍有切换会话后结果显示丢失、历史思考片段过碎、搜索依赖不可用等问题。详见 `docs/eval-reports/2026-11-08-real-web/index.html`，本次未推进阶段二。

- [x] **Task 4：用户、会话和独立 Worker**
  - 目标：本地账号登录（≤3 个，密码哈希存储）。每个用户一个 Worker 子进程，独立 data/users/<uid>/workspace 和 agent.db。一个用户可开多个会话并发运行。网关维护 runId → threadId 映射，迟到事件按 runId 丢弃；Worker 崩溃自动重启，并给进行中的运行发 error。前端侧边栏：新建、删除、改名会话。
  - 测试：两用户数据互不可见；同用户两会话并发不串事件；杀掉 Worker 后正确清理。
  - 演示：两个浏览器两个账号，各自并发跑两个会话。
  - 验证结果（2026-11-06）：
    - `gateway/gateway.test.ts` 5 项通过：真实子进程 WorkerPool 每用户一个进程、事件按用户分发、Worker 崩溃后通知并在下次调用时重启；RunHub 续传、拒绝他人事件、迟到事件丢弃、崩溃补发失败；注册上限 3 个、错误密码 401、未登录 401；两用户的运行事件、停止接口、工作空间文件互不可见（含 `..` 越界）；跨源请求被拒。
    - 密码用 scrypt 哈希，会话 Cookie 为 httpOnly + SameSite=Strict，服务端只存令牌的 SHA-256。
    - 前端侧边栏支持新建、改名、删除会话，运行中的会话显示指示点；多个会话可同时运行，切换会话不影响后台运行；刷新页面后自动接上运行中的轮次。

- [x] **Task 5：工作空间文件工具、命令执行和审批**
  - 目标：Mastra Workspace LocalFilesystem（contained: true）+ 8 个原生文件工具；local_command_execute（PowerShell，cwd 限定在用户工作空间，超时、输出上限、环境变量白名单）；工作空间外只读工具。两种权限模式（请求批准 / 完全访问），审批用 suspend/resume，前端显示批准卡片。
  - 测试：路径越界、junction 逃逸被拒；批准和拒绝后正确恢复；超时会终止命令。
  - 演示：让 Agent 写一个脚本并运行，弹出批准卡片。
  - 验证结果（2026-11-06）：
    - `agent/tools.test.ts` 中相关项通过：`..` 与工作空间外绝对路径被拒；junction 逃逸（包括其下尚不存在的新文件）被拒；命令在工作空间内执行、注入 GCMP_DWG_TOOLS、中文输出正常、密钥脱敏；cwd 越界与 pip 安装被拒；超时 1.5 秒结束整个进程树；非零退出码判为失败；环境变量走白名单；工作空间外只读工具可读外部文件、拒绝工作空间内路径。
    - 审批规则与原版一致：请求批准模式下，本地命令、工作空间外读取、依赖安装需要批准；本轮加载过 Skill 后该流程的命令免审批；完全访问模式全部免审批。
    - 真实运行：sol 写文件后执行 PowerShell 统计字节数，出现批准卡片，批准后继续并交付。

- [x] **Task 6：ask_user、present_files 和文件预览**
  - 目标：ask_user 挂起提问并恢复；present_files 只接受工作空间内真实存在的文件，显示成文件卡片；支持预览 HTML、PDF、xlsx、docx 和下载。
  - 测试：挂起恢复、刷新页面后恢复；不存在的文件被拒。
  - 演示：让 Agent 生成 HTML 报告，出现文件卡片并能预览。
  - 验证结果（2026-11-06）：
    - present_files 只接受工作空间内真实存在的文件并去重（测试覆盖缺失与越界）；ask_user 挂起恢复见 Task 3 测试。
    - 预览：HTML / SVG 在 sandbox iframe 中运行且服务端下发 CSP sandbox；PDF、图片直接显示；xlsx / docx / csv 由服务端转换成 HTML 后在无脚本 iframe 中显示；均可下载。
    - 真实运行：生成的 HTML 学习笔记、hello.html、41 MB 的 DXF 都以文件卡片交付。

- [x] **Task 7：Skills 和 Python 环境**
  - 目标：加载三个来源的 Skill：skills/own、skills/local.json 登记的用户自有 Skill、skills/vendor-bangtu。用 Mastra 原生 skill / skill_read / skill_search 按需加载，前端输入框支持 / 选择。uv + Python 3.13 托管环境，每个 Skill 独立环境；python_install_packages 只装 wheel，需审批。本轮加载过 Skill 后该流程命令免审批。Skill 里的工具路径（如 GCMP_DWG_TOOLS）通过环境变量注入。Skill 注册表支持难度标注，供 Task 2 路由使用。
  - 测试：Skill 目录发现；核实 description 超过 1024 字符的帮图 Skill 能否加载并记录结论；两个 Skill 依赖版本不同时环境互不影响。
  - 演示：/ 选择 dwg-to-dxf，把测试图纸转成 DXF。
  - 验证结果（2026-11-06）：
    - 发现 30 个 Skill：6 个用户自有（skills/local.json 登记，路径不复制）+ 24 个帮图副本（`scripts/sync-vendor-skills.ps1` 从 _extract 复制到 skills/vendor-bangtu，不进 git）。`apps/server/scripts/check-skills.ts` 核实 Mastra 原生加载器 30 个全部加载。
    - 关于 1024 字符：在已安装的 @mastra/core 1.69.0 中，24 个帮图 Skill 全部通过 `validateSkillContent`，原版测试里那 3 个失败的情况没有复现。另有 4 个帮图 Skill 的 frontmatter 不是严格 YAML，已改为回落到目录名和正则提取描述，不影响 Mastra 加载。
    - 测试覆盖：三类来源合并、同名去重、非法 Skill 记入 problems、难度标注；Python 包名校验（拒绝导入名、URL、本地路径）；按 Skill 隔离环境目录。
    - 真实运行：选择 /dwg-to-dxf 后，DeepSeek 读取技能、调用 gcmpDwgTools 把测试图纸转成 41 MB DXF，为该 Skill 的独立环境安装 ezdxf 并做 audit，最后交付 DXF。

- [x] **Task 8：MCP 客户端和自建搜索**
  - 目标：通用 MCP 客户端：listToolsetsWithErrors 发现、不加前缀、按服务注入 apiKey / messageId 并从 schema 剥离、输出脱敏、目录缓存 5 分钟、失败冷却 30 秒、单服务故障隔离、重名冲突停用。packages/search-mcp：docker-compose 起 SearXNG，包一层 MCP，提供 search_web 和 fetch_url。
  - 测试：本地假 MCP 服务验证注入、脱敏、冲突、故障隔离。
  - 演示：问一个需要联网的问题，回答里带来源链接。
  - 验证结果（2026-11-06）：
    - `agent/mcp.test.ts` 3 项：用本地真实 MCP 服务验证 apiKey / messageId 注入且不出现在模型可见 schema、输出脱敏、同名工具停用、故障服务隔离与提示、目录缓存、缺少凭据时不调用服务。
    - `packages/search-mcp` 5 项：SearXNG JSON 结果整理、服务不可用如实失败、网页正文提取、拒绝本机与内网地址（防 SSRF）、HTML 实体处理。
    - 真实运行：docker compose 启动 SearXNG（经本机代理出网），search-mcp 监听 127.0.0.1:8790/mcp；sol 先后调用 search_web 与 fetch_url，回答 GB 50016 现行版本并附政府网站来源链接。

- [x] **Task 9：规划 / 执行模式**
  - 目标：接在 Task 2 路由上。complex 任务由 L3 生成结构化计划（步骤、所需工具和 Skill、预期产出），前端显示计划卡片，用户确认后由 L2 或 L1 逐步执行，执行中可按升档规则升档。计划与执行分开记录追踪。
  - 测试：计划结构校验；确认 / 拒绝 / 修改计划的流程；执行阶段升档。
  - 演示：给一个复杂任务，看到计划卡片 → 确认 → 逐步执行。
  - 验证结果（2026-11-06）：
    - 计划由 L3 以 JSON 输出并经 zod 校验，失败重试一次，仍失败则直接交给 L3 执行并提示原因。前端计划卡片支持确认、修改（带意见重新规划）、取消。
    - 测试覆盖：规划后确认、按 executorTier 选择执行模型、计划注入执行上下文、拒绝即取消；执行阶段升档复用 Task 2 的升档逻辑。
    - 真实运行：复杂学习笔记任务由 gpt-6-astra 规划，确认后 gpt-6.1-sol 执行并交付；运行追踪里同时记录了两个模型。

- [x] **Task 10：运行追踪和对比模块**
  - 目标：每轮记录步骤、工具调用序列、模型组合、升档次数、token、耗时、估算成本、产出文件。同一问题可同时发给多个模型配置做对比。只读导入原版 bangtu.db（按会话标题或时间选择），与复刻版结果并排展示。judge（L3）按评分细则打分。评测用例放 evals/cases/*.yaml。对比页注明局限：原版用 deepseek-flash，复刻版用不同模型和框架，差异无法完全归因到模型。
  - 测试：导入器用脱敏样例库测试；指标计算用固定输入快照测试。
  - 演示：原版（导入）、DeepSeek、GPT 三列并排。
  - 验证结果（2026-11-06）：
    - `gateway/compare.test.ts` 7 项：用结构相同的脱敏样例库验证原版导入（按用户消息切分轮次，归集模型、tokens、步数、工具调用、交付文件、耗时，且不改动原库）；指标结构快照；五类断言；评审提示词与评审 JSON 解析；YAML 用例加载与校验；对比记录按用户隔离。
    - 原版数据库正被原版软件使用，导入时先把 db 与 -wal 复制成快照，再只读快照。
    - 真实运行：`scripts/smoke-compare.mjs` 读到原版会话"识别试验厂房施工图"的 7 轮及其指标；用评测用例 general-intro 让 DeepSeek 与 sol 并排运行，gpt-6-astra 评审打分（DeepSeek 3 分，超字数且有未证实的能力声明；sol 7 分）。
    - 评测用例在 `evals/cases/`（3 个通用用例）。对比页已注明局限：原版用 deepseek-flash 与帮图云端 MCP，差异不能完全归因于模型；原版成本单价未知，不做估算。

### 阶段二：自研图纸 MCP（免费层全部本地实现）

- [ ] **Task 11：drawing-mcp 骨架和任务队列**
  - 目标：packages/drawing-mcp，FastMCP Streamable HTTP 服务。bangtu_create_dwg_task 接受 fileBase64+fileName 或本地路径，按文件 SHA256 去重，调用 GCMP_DWG_TOOLS 转 DXF；实现 bangtu_get_task_status、bangtu_wait_task。工具名、参数、返回包装与帮图一致（见 docs/00-analysis.md 第 5 节）。
  - 测试：转换成功判定按 dwg-to-dxf Skill 规则（日志含 Convert2Dxf OK、无 Teigha Error、DXF 以 EOF 结尾）；失败路径。
  - 演示：上传测试图纸，任务状态变为 SUCCESS。

- [ ] **Task 12：bangtu_get_frame_result**
  - 目标：复用 dxf-frame-splitter 的图框识别，解析图签（INSERT/ATTRIB 实际填值），输出 frameId、signInfo、frameWcsLoc、layoutName。
  - 测试：用测试图纸做快照；字段缺失时标为未识别，不编造。
  - 演示：输出测试图纸的图框列表和图签字段。

- [ ] **Task 13：图元下载和截图**
  - 目标：bangtu_get_frame_entities_download_url 按图框导出图元，按 AcDb* 类型分组，gzip JSON，返回本地下载链接（30 分钟有效）；bangtu_capture_screenshot_in_frame 按 wcsLoc 渲染指定区域 PNG。
  - 测试：图元分组结构校验；截图区域与坐标一致。
  - 演示：下载一个图框的图元，截一张局部图。

- [ ] **Task 14：接入 Agent 并做第一次端到端对比（免费）**
  - 目标：Agent 与 Skill 命令都指向 drawing-mcp（BANGTU_MCP_URL 指向本地，BANGTU_API_KEY 用本地占位符）。用 bangtu-dwg-classify-catalog-manage 生成图纸目录，与原版软件结果对比。
  - 断言：图框数一致；图签字段逐项对比；产出文件存在；没有编造结果。
  - 演示：对比页显示自研 MCP 与原版的目录差异。

### 阶段三：构件识别（研发）

- [ ] **Task 15：bangtu-proxy（可选，花币）**
  - 目标：帮图云端代理。真实 key 只在代理进程内；按文件 SHA256、product+frameId、taskId+参数缓存到 data/cache/；扣费账本按价格表计费，硬上限默认 10 币（BANGTU_BUDGET_COINS）；每次付费调用前在网页弹确认卡片，缓存命中不弹。先用免费的 get_frame_result 数出图框数，报出预计花费，用户确认后才跑付费部分。
  - 测试：假上游验证重复调用不再转发、超预算拒绝、key 不出现在任何返回和日志里、兼容 SSE 响应。
  - 演示：tools/list 列出工具，账本扣费为 0。

- [ ] **Task 16：规则型 bangtu_get_cv_result**
  - 目标：先实现 texts、axisNumber、alignedDims、textelvation，再实现 planDoor / planWindow（按天正块名 $DorLib2D$ / $WINLIB2D$ 等规则）。与 Task 15 拿到的帮图结果对比，算准确率。
  - 演示：同一图框，自研识别与帮图结果并排及准确率。

- [ ] **Task 17：房间和楼梯识别**
  - 目标：规则方法（墙线围合 + 房间名文字）加 GPT 视觉复核。跑通 bangtu-door-and-window-section 的端到端对比。
  - 演示：门窗专篇产出，与原版对比。

### 阶段四：接近 Codex 的界面（之后细化）
- 工作空间文件树、终端面板、diff 视图、后台任务通知、会话分叉。

## 用户追加：品牌、会话命名与发布（2026-11-09）

本轮用户明确要求连续完成以下发布工作，作为一个交付项执行；不推进阶段二 Task 11。用户已选定混合部署，覆盖早期“不用 Docker”的部署约束。

- [x] **发布：帮帮图图、首轮问答命名、GitHub 与本地 Docker 入口**
  - 品牌显示改为帮帮图图；首次成功问答完成后概括生成短标题，后续问答与手动名称不覆盖；失败回退不影响回答。
  - 测试使用本地假模型；验证正常命名、只执行一次、自定义/并发改名保护及命名失败回退。
  - 上传至用户指定的 `yuancustom/bangtucraft`。提交前审计暂存区，不包含真实 .env、运行库、用户图纸/截图、逆向材料及 vendor Skills。
  - Docker 托管前端和无缓冲 SSE 反向代理；执行端继续运行于 Windows，保留原用户数据与 CAD 工具。验证容器健康、登录、真实问答与内网地址。
  - 已验证（2026-11-09）：全量 10 文件 70 项 vitest、typecheck、lint、Vite 生产构建通过；Docker 容器 healthy，两个宿主机内网接口均返回 200。真实网页首轮问答后自动命名为“变电站主变压器作用”，刷新后名称保留，原账号/历史/模型文件可见。已登记 Windows 登录启动任务。
  - 安全核验：112 个待提交文件中未匹配已配置密钥或常见凭据格式；真实 .env、用户数据、CAD 图纸及截图、vendor Skills 和逆向材料均被排除。容器导出文件系统与运行配置未匹配已配置密钥，且没有宿主机挂载。
  - GitHub：完成官方 GitHub CLI 授权后，已将包含免登录更新的代码推送至 `yuancustom/bangtucraft` 的 `main`（功能提交 `b79451c`）。提交区 113 个文件密钥扫描无问题，真实配置和用户数据未上传。

## 用户追加：免登录工作空间（2026-11-09）

- [x] **打开即用并更新当前混合部署**
  - 默认 `AUTH_MODE=local`，服务端统一绑定本地用户，所有 API 与 SSE 无需 Cookie；界面不再显示登录、注册或退出。可配置 `accounts` 恢复原独立账号模式。
  - `.env` 中指定原工作空间用户，保留其历史和模型；空库并发初始化只创建一个用户，配置不存在的用户 ID 时拒绝启动。保留同源检查及文件路径限制。
  - 验证：11 文件 76 项 vitest、typecheck、lint、前端生产构建全部通过。新增测试覆盖并发初始化、重启复用、已有用户选择、错误 ID、无 Cookie 会话/文件/SSE、旧 Cookie 不切换用户、跨源写入拒绝及账号接口关闭。
  - 真实部署：Windows 执行端重启、Docker 重建后 healthy；本机及两个内网接口无 Cookie 访问均进入原用户的 17 个历史会话。原 DWG 收尾 R3 模型下载成功，8,317,953 字节与磁盘内容哈希一致。真实网页直接进入工作空间并成功新建会话。Nginx 增加缓存重新验证，刷新后加载最新免登录界面。

## 已知风险
- 帮图 Skill 和脚本有版权风险，只能内部对比，产品要用自研 Skill 替代。
- gcmpDwgTools 使用 ODA Teigha，对外发布需确认 ODA 授权。
- 3 个帮图 Skill 依赖 AutoCAD accoreconsole.exe。
- 用户在对话里贴过的 API key 应在测试后重新生成。
