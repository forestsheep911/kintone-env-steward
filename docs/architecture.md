# 技术架构

## 逻辑分层

```text
Sources: official kintone MCP / User API / custom REST collectors / Admin UI / baseline
                              │
                              ▼
Collector → Normalizer → Versioned Snapshot
                              │
                              ├─ Diff Engine
                              └─ Policy Evaluator
                                      │
                                      ▼
                         Findings + Exceptions
                                      │
                                      ▼
                    Remediation Planner / Reporter
                                      │
                         explicit approval only
                                      ▼
                         Executor → Verifier
```

## 设计原则

### 采集与判断分离

采集器只获取事实并记录来源。Normalizer 把不同来源映射为稳定模型。规则不直接依赖
网页 DOM 或临时 API 返回结构。

官方 MCP 是首选的交互式采集适配器，但不是领域模型。字段、布局、流程等 MCP
结果必须进入相同的 Normalizer；用户、组织、组、权限、自定义项、Webhook 等覆盖
缺口由确定性 REST 脚本补齐。随着产品成熟，关键快照与 Diff 应逐步由可测试脚本
负责，MCP 主要保留为交互入口与官方能力适配层。

### 快照是中心产物

快照应可版本化、可比较、可脱敏。报告是快照与规则结果的视图，不是唯一事实来源。
首版建议以 JSON 为交换格式，必要时用 SQLite 支持查询。

### 确定性规则与 AI 分工

- 确定性代码：采集、规范化、schema diff、规则条件、格式校验。
- Codex：补充语境、处理证据冲突、解释影响、组织整改顺序和报告。

### 写路径单独设计

每种可变更资源都需要精确目标、current/desired diff、依赖检查、用户审批、恢复方案、
写后复核和不含密钥的运行记录。

## 计划中的产物

```text
outputs/kintone-env-steward/<timestamp>/
├── run.json
├── snapshot.json
├── findings.json
├── exceptions.json
├── remediation-plan.md
├── report.md
└── report-site/
    ├── index.html
    ├── report-data.json
    ├── app.js
    └── styles.css
```

插件目录保持只读，不存储客户配置、记录或凭据。

本地环境配置台由 Node.js 内置 HTTP 服务提供，不依赖外部 Web 框架。服务只绑定
`127.0.0.1`，将环境契约保存到用户活动工作区；它不直接访问 kintone，也不采集
真实凭据。详见 [本地环境配置台规格](local-configuration-console.md)。

## 首个垂直切片

对一个明确环境运行 App 清单、字段、布局、流程、一般设置和部署状态的只读采集，
把结果规范化为快照并生成本地 HTML 报告。随后增加用户、组织、组、权限和
JavaScript/CSS 自定义项，再支持同环境前后比较和两个环境之间比较。
