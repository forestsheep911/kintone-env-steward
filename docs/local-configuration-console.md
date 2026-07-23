# 本地环境配置台规格

## 目的

本地配置工作台把 `.kintone-env-steward/environments.yaml` 的编辑、检查和保存变成
自适应界面。它由 React、TypeScript、Vite、Tailwind CSS 和本地 shadcn 组件构成；
简单任务只显示必要字段，复杂任务再展开环境元数据。权限始终只有“只读 / 读写”。

## 运行边界

- 固定监听 `127.0.0.1`，不接受局域网或公网连接；
- 默认端口 `4317`，可用 `--port` 修改；
- 通过 `--workspace` 指定治理项目目录，默认使用启动命令的当前目录；
- 通过 `--ui-mode auto|simple|advanced` 决定初始界面密度，默认 `auto`；
- 通过 `--initial-context <json|yaml>` 预填聊天中已经确认的非敏感信息；
- 只读写 `<workspace>/.kintone-env-steward/`；
- 环境契约保存在可读性更好的 `environments.yaml`，真实账号信息另存为
  `credentials.local.json`；
- 如果只发现旧版 `environments.json`，首次读取时自动生成 YAML，原 JSON 保留；
- `credentials.local.json` 默认被 Git 忽略，只在本机使用；当前版本没有静态加密，
  依赖操作系统账号和文件权限保护；
- 页面、API 和静态资源都设置为不缓存；
- 修改 API 同时校验 Origin、随机 CSRF Token 和 JSON Content-Type；
- 请求体上限为 1 MiB；
- 配置保存前必须通过环境契约验证器；
- 覆盖配置前在同一目录生成带时间戳的 backup。

## 自适应界面

`auto` 模式在只有一两个普通环境时使用简洁界面；出现三个以上环境、客户实施环境、
客户端证书时自动进入完整模式。用户可随时在“简洁 / 完整”之间
切换，隐藏字段仍保留原值。

初始上下文只接受客户别名、环境地址、App 范围、环境别名和访问模式等非敏感信息。
用户名、密码、Token、证书密码不能写入启动上下文。

## 页面结构

### 01 项目

- 项目 ID；
- 客户别名，不要求真实法人名称；
- 治理产物的工作区相对目录。

### 02 环境

每张环境卡包含：

- 环境别名、稳定 ID、类型和 HTTPS 地址；
- 所需角色，默认系统管理员；
- 访问模式：`read-only` 或 `read-write`；
- App ID 范围；接受 `*`、单个正整数、逗号列表和闭区间，例如
  `1,3-5,7-12,53,66`；
- 登录方式以及直接输入的用户名、密码、Token 或证书信息；

支持新增、复制和删除环境。真实用户名、密码、API Token、证书和证书密码通过本机
页面录入，但不能写入环境契约；它们只写入 git-ignored 的本机凭据文件。再次打开
页面时只返回“已配置”状态，不向浏览器回传已保存的值。

环境区一次只渲染当前选中的环境。用户通过下拉框在环境之间切换；新增或复制后自动
选中新环境，删除后切换到相邻环境。环境数量增加不会继续拉长页面。

环境类型会自动推导内部工作流：只有客户源环境时使用只读分析；出现实验环境或
客户实施环境时切换为实验闭环。用户不需要单独配置流程。

### 03 检查

页面显示环境总数和允许写入的环境数。服务器验证以下
规则后才启用保存：

- 每个环境必须明确选择只读或读写；
- 凭据字段只能是合法的环境变量名；
- API Token 不能表示系统管理员登录；
- 环境和产物路径不能逃出工作区；
- 流程引用必须与环境类型一致。

## 聊天触发的权限变更

当聊天中明确提出写操作，而目标环境当前为只读时，Skill 通过
`request-access-change.mjs` 写入一次性本机请求。配置页轮询到请求后弹出阻塞式
确认框，显示环境、当前模式、目标模式和聊天中的具体理由。

用户确认后，服务器只修改 `environments.yaml` 中对应环境的 `accessMode`；拒绝则
保持原配置。两种选择都会清除一次性请求。确认本身不会执行聊天中的操作。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 服务状态和版本 |
| GET | `/api/meta` | 工作区、配置路径和操作目录 |
| GET | `/api/config` | 已保存配置或安全起始配置 |
| GET | `/api/credentials/status` | 只返回各环境的凭据配置状态 |
| GET | `/api/access-request` | 读取待确认的本机权限变更请求 |
| POST | `/api/validate` | 只验证，不写文件 |
| POST | `/api/config` | 验证通过后保存环境配置与本机凭据变更 |
| POST | `/api/access-request/resolve` | 确认或拒绝权限变更并写回 YAML |

该 API 是本机配置界面的内部接口，不是远程管理接口，也不直接连接 kintone。

## 启动

从仓库根目录：

```powershell
node plugins/kintone-env-steward/skills/kintone-env-steward/scripts/config-ui-server.mjs
```

指定其他治理工作区：

```powershell
node <config-ui-server.mjs> --workspace C:\work\customer-a --port 4317 --ui-mode auto --initial-context C:\work\customer-a\.kintone-env-steward\config-context.local.json
```

Codex 调用 skill 时，应向用户报告实际 URL 和配置文件路径。环境契约保存后，再由
skill 校验所选环境和操作边界。v0.0.16 负责把凭据安全地留在本机工作区，但不会把
凭据文件的内容返回对话，也不会自动重启已经运行的官方 MCP；按活动环境自动注入
凭据并重启 MCP 是后续版本的独立能力。
