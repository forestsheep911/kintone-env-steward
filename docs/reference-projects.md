# 参考项目结论

## kintone-setup-toolkit-codex-plugin

参考路径：
`C:\Users\bxu\dev\personal\kintone-setup-toolkit-codex-plugin`

可继承的经验：

- read-only audit 与受控 provisioning 分轨；
- 环境操作、知识、审计、风险复核等职责分离；
- 用 JSON Schema 和 Markdown 模板固定交付物；
- API/MCP 未覆盖的设置，可以用浏览器观察补证；
- 运行产物写入用户工作区，不写入已安装插件；
- 凭据通过工作区 `.env` 提供且不进入版本库。

新项目的调整：

- 从“交付前 setup toolkit”转为“环境全生命周期治理”；
- 从多个早期 skill 收敛为一个入口 skill，待工作流稳定后再拆；
- 把版本化 snapshot、diff、policy、exception 作为核心领域对象；
- 写能力不进入首版，避免产品定位被 provisioning 主导。

## cybozush_ana

参考路径：`C:\Users\bxu\studios\cybozush_ana`

该项目展示了把 kintone 记录拆入 SQLite 后进行销售漏斗、续约风险、附件完整性和
行动清单分析的能力。这证明离线存储与确定性查询很适合承载可重复分析。

对本项目的启发：

- SQLite 可以作为快照查询和规则调试的内部实现；
- 确定性 SQL/代码应先产出事实，AI 再解释；
- dashboard 中的记录级指标属于业务数据分析，不应成为治理核心；
- 如果以后引入数据健康信号，应优先保存聚合值，并与 schema/config 快照分层。

