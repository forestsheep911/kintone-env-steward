# kintone 官方 MCP 接入

## 版本与定位

`0.0.16` 固定使用 `@kintone/mcp-server@1.9.0`。官方 MCP 是首批配置采集和自然语言
交互的适配器，不是环境快照、治理规则或 Diff 的事实模型。

## 启用的工具

插件通过 Codex 的 `enabled_tools` 只开放：

- `kintone-get-app`
- `kintone-get-apps`
- `kintone-get-form-fields`
- `kintone-get-form-layout`
- `kintone-get-process-management`
- `kintone-get-app-deploy-status`
- `kintone-get-general-settings`

记录查询、记录写入、状态更新、字段修改、布局修改、App 部署和空间写入工具均未在
本版开放。

`0.0.16` 使用 `kintone-get-apps` 把 `*` 范围解析成明确 App ID，再逐 App 调用其余
只读工具。API Token 模式下，官方 MCP 可能不注册环境级 App 清单工具；因此 `*`
范围目前要求使用具备相应读取权限的用户名/密码认证。空间工具仍不在 allowlist。

## 配置

在启动 Codex 前通过本机环境变量提供：

```text
KINTONE_BASE_URL=https://example.cybozu.com
```

认证二选一：

```text
KINTONE_USERNAME=
KINTONE_PASSWORD=
```

或：

```text
KINTONE_API_TOKEN=
```

不要把真实凭据写入 `.mcp.json`、插件文件、Git 或测试提示词。API Token 最多可用
逗号分隔方式提供九个。密码认证与 Token 同时存在时，官方 MCP 会优先使用密码认证。

## 安全边界

- `enabled_tools` 是 `0.0.16` 的主要工具面限制。
- `KINTONE_ALLOW_CHANGES=false` 是 Steward 的策略信号，不会改变官方 MCP 自身行为。
- 仍应使用最小权限账户或 Token，并优先连接测试环境。
- Skill 指令是工作流约束，不替代凭据权限和工具 allowlist。
- 当前官方 MCP 不支持 Guest Space 内的 App。

## 后续脚本化方向

优先把这些能力做成确定性、可测试脚本：

1. MCP 响应到 `environment-snapshot.v1` 的规范化；
2. schema/config 稳定排序与脱敏；
3. 两份快照的结构化 Diff；
4. 权限、View、JavaScript/CSS、Webhook 和插件配置采集；
5. 高信噪比治理规则；
6. 离线 fixture 和回归测试。

脚本应输出稳定 JSON，MCP 和 Codex 负责选择范围、调用与解释。这样既保留官方 MCP
的接入便利，也避免长期依赖模型临场拼装治理结果。
