# 多环境治理工作流

## 目标流程

```text
客户真实环境（只读）
  → 本地受控 dump
  → 离线分析与假设
  → 实验环境 1 / 2 / 3 分别试行
  → 结果比较与客户汇报
  → 客户确认
  → 目标环境受控实施
  → 写后复核
```

## 首次使用向导

用户不需要创建或编辑 JSON/YAML。直接说：

```text
使用 $kintone-env-steward，我想分析一个 kintone 环境。
```

Skill 会先在聊天中确认环境地址、App 范围，以及单环境分析还是完整
实验流程。它只把非敏感信息作为配置台的启动上下文，用户名和密码仍由用户在本机
页面中输入。

在 Codex Desktop 中，推荐直接打开本地配置台：

```powershell
node skills/kintone-env-steward/scripts/config-ui-server.mjs --workspace <工作目录> --ui-mode auto --initial-context <本机上下文.json>
```

访问 `http://127.0.0.1:4317` 后，简单任务只显示环境地址、App 范围、访问模式和
登录信息；多环境、证书或实施目标会自动进入完整模式。用户也可以随时切换，
不会丢失字段。它只监听本机回环地址，保存前会运行同一份配置验证器；真实用户名、
密码、Token 和证书只在页面中采集并写入本机凭据文件，不进入 YAML 或聊天。

也可以运行终端向导：

```text
node skills/kintone-env-steward/scripts/setup-environments.mjs
```

向导会生成 `environments.yaml` 和一个空白凭据清单。它不会询问真实密码或 Token。

插件在用户的活动工作区读取：

```text
.kintone-env-steward/environments.yaml
```

该文件包含客户与环境元数据，默认被 `.gitignore` 忽略。可以从插件中的
`assets/environments.example.yaml` 复制一份开始配置。

`activeEnvironmentId` 表示当前 Codex 任务连接的环境。`0.0.17` 中，官方 MCP 仍从
通用的 `KINTONE_BASE_URL` 和认证环境变量启动；它们必须指向 active environment。
环境专用的 credential references 为后续 profile launcher 和确定性脚本准备。

## 两层权限

### 身份能力

治理检查通常需要看到 App 配置、权限、流程、扩展和环境设置，因此建议用户提供
独立的系统管理员账号。凭据只通过环境契约中的环境变量名称引用，不写入 YAML；
真实值由本机凭据文件单独保存。

系统管理员身份只是“这个账号技术上能做什么”，不是插件的操作授权。

### 任务授权

每个环境只选择 `read-only` 或 `read-write`。具体要读取或修改什么，由当前聊天说明，
不再保存逐项操作和审批复选框。聊天要求写入但环境仍为只读时，插件会让本机配置页
弹出确认框；只有用户在网页中确认后，才把该环境改为读写并写回 YAML。确认不会自动
执行聊天中的操作。

## 环境角色

- `customer-source`：真实客户资料来源；默认只读。
- `experiment`：隔离的新环境；用于验证不同假设，可按环境开放写权限。
- `customer-target`：最终实施目标；默认只读，只有完整审批门通过后才能计划写入。

## 凭据

推荐每个环境使用不同账号和不同环境变量：

```text
CUSTOMER_SOURCE_ADMIN_USERNAME
CUSTOMER_SOURCE_ADMIN_PASSWORD
LAB1_ADMIN_USERNAME
LAB1_ADMIN_PASSWORD
```

不要在对话、YAML、Markdown、Git 或报告中粘贴凭据。对于环境级治理，API Token
通常不足以覆盖全部管理员配置；App 数据 dump 可以另行使用范围更小的只读 Token。

## 验证

从插件安装目录运行：

```text
node skills/kintone-env-steward/scripts/validate-environments.mjs <配置路径>
```

加上 `--check-env` 时，验证器还会确认配置引用的环境变量是否存在，但不会输出值。

## 当前执行边界

`0.0.17` 使用 YAML 环境契约，以环境访问模式自动推导流程，并建立 App ID 列表/区间表达式、单环境选择器、自适应本地配置工作台、聊天预填、权限变更弹窗、直接凭据录入、一键只读快照、HTML 报告站点、向导、验证和工作流边界。官方 MCP 工具面仍保持只读，因此即使实验环境
配置允许写入，本版也只会生成试行计划，不会执行。后续确定性脚本或分环境写入工具
必须同时满足配置授权、当次用户审批和写后复核。
