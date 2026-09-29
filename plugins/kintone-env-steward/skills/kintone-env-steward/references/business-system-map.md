# 业务系统地图与治理基线

首次从快照生成候选地图：

```powershell
node scripts/initialize-business-system-map.mjs --snapshot <snapshot.json> --output <workspace>/.kintone-env-steward/business-system-map.json
```

候选由显式 schema 关系或同 Space 产生。人工将 `status` 改为 `confirmed` 后，应填写
`name`、`owner`、`criticality`、`lifecycle`，并按需设置 `policy`。任何 App 的合并、拆分、
排除或政策例外均是人工治理决策，脚本不会自动重写既有地图。

分析入口会自动读取工作区 `.kintone-env-steward/business-system-map.json`。当一个系统被
标记为 `confirmed`，且 `policy.allow_everyone_record_delete` 明确为 `true` 时，属于它的
App 不再触发开放删除的待确认发现；其他权限规则不受此例外影响。

地图的 `environment_id` 必须与快照一致，否则报告生成会报错。关系候选 ID 由排序后的
成员 App ID 生成，不随其他系统新增而变化。旧地图中的序号 ID 不再用于匹配，只有成员
集合一致的候选才继承人工标签；成员发生变化后需要重新确认。政策仍按地图明确列出的
App 生效，不自动扩展到新增成员。
