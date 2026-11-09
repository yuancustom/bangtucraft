# AGENTS.md

本项目是一个独立的网页端 Agent 平台，参照"帮图Mind"桌面端的架构（单 Agent + Skills + MCP），面向建筑图纸理解场景。部署在本地 Windows，最多 3 个用户。

## 开工前必读
- docs/00-analysis.md：原版帮图Mind 的结构分析（框架、循环、工具、Skill、模型）。
- docs/01-plan.md：实施计划。严格按任务顺序推进，每完成一个任务就勾选并写明验证结果，然后停下来等用户确认，再做下一个。

## 硬性规则
- 密钥只放在 .env，绝不写进代码、文档、日志、测试快照或提交记录。日志和 SSE 推送要脱敏。
- 不修改 _extract/、_tools/、bangtuMind-setup.exe。这些是逆向分析的只读材料。
- skills/vendor-bangtu/ 是帮图 Skill 的副本，只能内部做对比，不进 git，不随产品分发。
- 帮图云端里专业构件识别（create_*_task）每张图框扣 1 帮图币，用户余额很少。没有用户明确同意，不得调用付费工具。图元下载 0.05 币、截图 0.01 币，同样要先征得同意。
- Mastra 版本固定为 1.69 系列（@mastra/core ^1.69.0、@mastra/memory ^1.31.0、@mastra/libsql ^1.23.1、@mastra/mcp ^2.1.0），与原版一致。写 Mastra 代码前先读已安装包的类型定义和文档，不要凭记忆写 API。
- 每个任务都要有测试（vitest / pytest）。测试用本地假服务替代真实模型和 MCP，不在默认测试里联网或花钱。
- 只做计划里写的内容，不额外扩展功能。

## 本地工具位置（通过环境变量注入，不要在代码里写死）
- GCMP_DWG_TOOLS = E:\Code\gbmp\tools\gcmpDwgTools\bin\VS2022\gcmpDwgTools.exe（ODA Teigha，DWG→DXF / PNG / 实体导出）
- 用户自有 Skill：C:\Users\yangxy-q\.codex-switcher\skills\（dwg-to-dxf、gcmp-dwg-tools、dxf-frame-splitter、subdrawing-to-3d、floorplan-variants-to-ifc、room-equipment-layout）
- 测试图纸：E:\Code\tuzhilijie\samples\M1478Z02J试验厂房施工图_t3.dwg
- 原版帮图Mind 数据库（只读导入）：C:\Users\yangxy-q\AppData\Roaming\bangtuMind\data\bangtu.db
