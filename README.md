# kintone-env-Steward

`kintone-env-Steward` 是一个面向 kintone 环境治理的 Codex 插件项目。
它帮助管理员、交付团队和支持团队看清环境现状，发现配置偏差与长期风险，并把
整改工作变成可审阅、可验证、可追踪的计划。

当前版本是开发版（`0.0.17`）。它提供基于 React、Vite 和 shadcn 组件结构的自适应
本地配置工作台，不需要手工编辑配置文件。简单任务只显示必要字段；多环境、证书、
或实施目标等复杂任务会自动显示完整设置。聊天中已经确认的非敏感信息可以在
启动时预填，用户名和密码仍只在本机页面中录入。只读分析完成后会生成独立的
HTML 治理报告，并通过 `127.0.0.1:4318` 提供本地浏览、筛选和 App 结构下钻。

## 为什么做这个项目

kintone 很容易从少量 App 快速成长为业务关键系统，但环境长期演进后，常见问题
并不只在记录数据本身，而在配置层：

- App、字段和流程缺少统一的命名与设计基线；
- 权限、负责人和用途随着人员与业务变化而失真；
- JavaScript/CSS、插件、Webhook 和外部集成缺少清单；
- 测试、交付和生产环境之间的 schema 差异难以解释；
- 整改依赖人工经验，缺少证据、优先级、审批和复核闭环。

本项目把这些问题视为“环境治理”，而不是一次性的 App 检查。

## 产品主链路

```text
环境发现
  → 配置与 schema 快照
  → 治理规则评估
  → 风险与偏差说明
  → 整改计划 / 差异预览
  → 明确审批后执行
  → 复核与治理记录
```

首版默认只读。任何写操作都必须由后续实现显式支持，并在当次任务中获得用户对
目标和变更内容的明确授权。

## 范围

核心关注：

- 环境、空间和 App 清单；
- 用户、组织、组、服务账号与管理员身份；
- 字段、布局、视图、流程管理与权限；
- 自定义 JavaScript/CSS、插件、Webhook 与外部集成；
- App 所有者、用途、生命周期、重复与废弃风险；
- 环境间 schema/config 差异；
- 治理基线、例外、整改计划和验证证据。

暂不作为核心：

- 面向具体业务的销售、续约或经营看板；
- 大规模记录内容分析或数据质量修复；
- 未经审批的自动配置变更；
- 备份、迁移和发布平台的完整替代品。

记录数据以后可以用来补充判断，例如空字段比例、长期无记录更新或流程滞留，但
它必须与 schema/config 治理分层。

## 仓库结构

```text
.
├── docs/
├── plugins/
│   └── kintone-env-steward/
│       ├── .codex-plugin/plugin.json
│       ├── .mcp.json
│       └── skills/kintone-env-steward/
└── .env.example
```

## 文档入口

- [产品背景](docs/product-background.md)
- [产品范围与治理模型](docs/product-scope.md)
- [技术架构](docs/architecture.md)
- [MVP 路线图](docs/roadmap.md)
- [参考项目结论](docs/reference-projects.md)
- [官方 MCP 接入](docs/mcp-integration.md)
- [多环境治理工作流](docs/multi-environment-workflow.md)
- [本地环境配置台规格](docs/local-configuration-console.md)

## 开发状态

当前工作区版本已接入本地 SQLite 扫描存储（需要 Node.js 24.16+），逐资源落盘，支持
历史查询、失败重试和 JSON 快照导出；原有 HTML 报告流程保留。详见
[本地扫描存储](docs/local-scan-storage.md)。

已完成 Git 仓库、Codex 插件基础结构、单一入口治理 skill、治理对象与安全边界，
并接入 kintone 官方 MCP `1.9.0` 的只读配置工具集。v0.0.17 的本地配置工作台支持
直接输入账号信息；真实值保存到 git-ignored 的本机文件，环境契约使用更易读的 YAML：

```powershell
node plugins/kintone-env-steward/skills/kintone-env-steward/scripts/config-ui-server.mjs
```

打开 `http://127.0.0.1:4317` 后即可编辑当前工作目录的环境契约。服务器不接受公网或
局域网连接，配置中只保存凭据环境变量名，不保存真实凭据。

治理运行生成 `snapshot.json` 后，插件会在同一运行目录创建 `report-site/`，并在
`http://127.0.0.1:4318` 展示。报告只包含治理证据和结构信息，不包含凭据或记录内容。

`0.0.17` 提供可重复的一键只读分析入口：

```powershell
node plugins/kintone-env-steward/skills/kintone-env-steward/scripts/analyze-environment.mjs `
  --workspace . `
  --environment customer-source
```

若要补充管理页可见的全量 App 目录、容量和管理页覆盖状态，可显式增加
`--include-admin-ui`。该层通过经审查的内部只读适配器采集，并在快照中标记为
`ui-derived`；它不替代官方 MCP/REST 的已发布配置采集。

身份治理已进入快照契约，但 `0.0.17` 仍明确标记为未采集。下一步建议完善用户、
组织、组、权限、视图、JavaScript/CSS、Webhook 和插件配置采集，再增加 App 间
schema diff、历史快照对比和报告中的证据下钻。
