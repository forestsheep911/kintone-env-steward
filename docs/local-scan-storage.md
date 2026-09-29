# 本地扫描存储

扫描现在使用 Node 内置 SQLite；运行环境要求 Node.js 24.16 或更高版本，无需安装数据库服务或 npm 数据库驱动。

工作区 `.kintone-env-steward/scans.sqlite` 保存运行批次、逐资源证据、状态、采集时间和最终快照。WAL 模式允许读取历史时继续写入。数据库及其 WAL/SHM 文件均被 Git 忽略，不保存登录凭据。数据库包含环境配置证据，应按客户数据管理。

每次运行生成独立 ID。MCP 每次成功调用、REST 每个 App 设置完成后立即保存；失败保存通用错误标记，不保存服务器错误正文。后台适配器逐资源保存已脱敏的累计摘要，不保存 HTML、密码、Cookie 或令牌正文。

已有的 `snapshot.json`、`run.json`、`report-site/` 保持可用。最终快照先写入数据库，再导出文件。`run.json` 增加数据库位置、复用来源及逐资源时间，报告仍读取 JSON。旧 JSON 运行不自动导入数据库。

以下命令中的脚本路径均相对于 `plugins/kintone-env-steward/skills/kintone-env-steward/`：

```powershell
node scripts/scan-history.mjs --workspace <workspace>
node scripts/scan-history.mjs --workspace <workspace> --run <run-id>
node scripts/scan-history.mjs --workspace <workspace> --run <run-id> --export outputs/recovered/snapshot.json
node scripts/analyze-environment.mjs --workspace <workspace> --environment <id> --resume-from <run-id>
```

导出拒绝覆盖已有文件。恢复时必须保持域名、环境 ID、App 范围和补采开关一致；成功的 MCP/REST 资源复用，失败或尚未采集的资源重新请求。恢复生成新批次，不改写原批次。复用数据保留原采集时间，因此它是中断任务的补全，不是全新的同一时刻快照；需要刷新环境时不要传 `--resume-from`。后台实验性采集每次重跑。

强制终止进程可能留下 `running` 批次，其已提交资源仍可恢复。此状态不证明进程仍存活。目前不支持多个进程共同写同一个运行 ID、自动历史清理或数据库中的文件正文资产。身份和配置覆盖范围不因引入数据库而扩大。

离线验证：`node --test tests/*.test.mjs`。测试覆盖关闭重开后的证据保留、失败重试、成功复用、环境隔离、历史保留和快照读取。
