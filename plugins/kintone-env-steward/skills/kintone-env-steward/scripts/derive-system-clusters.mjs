const compareIds = (left, right) => Number(left) - Number(right);

export function deriveSystemClusters(apps) {
  const appById = new Map(apps.map((app) => [String(app.id), app]));
  const adjacency = new Map([...appById.keys()].map((id) => [id, new Set()]));
  const edges = new Set();
  for (const app of apps) {
    for (const relation of app.relationships ?? []) {
      const from = String(app.id);
      const to = String(relation.relatedApp);
      if (from === to || !appById.has(to)) continue;
      adjacency.get(from).add(to);
      adjacency.get(to).add(from);
      edges.add([from, to].sort(compareIds).join("-"));
    }
  }
  const visited = new Set();
  const components = [];
  for (const id of appById.keys()) {
    if (visited.has(id) || adjacency.get(id).size === 0) continue;
    const stack = [id], members = [];
    visited.add(id);
    while (stack.length) {
      const current = stack.pop();
      members.push(current);
      for (const related of adjacency.get(current)) {
        if (!visited.has(related)) { visited.add(related); stack.push(related); }
      }
    }
    components.push(members.sort(compareIds));
  }
  const included = new Set(components.flat());
  const candidates = components
    .sort((left, right) => right.length - left.length || compareIds(left[0], right[0]))
    .map((appIds, index) => ({
      id: `relationship-${index + 1}`,
      kind: "connected-system",
      confidence: "high",
      app_ids: appIds,
      evidence: ["字段 Lookup 或相关记录形成显式 App 关系"]
    }));

  const bySpace = new Map();
  for (const app of apps) {
    const id = String(app.id);
    if (included.has(id) || !app.spaceId) continue;
    (bySpace.get(String(app.spaceId)) ?? bySpace.set(String(app.spaceId), []).get(String(app.spaceId))).push(id);
  }
  for (const [spaceId, appIds] of bySpace) {
    if (appIds.length < 2) continue;
    for (const id of appIds) included.add(id);
    candidates.push({
      id: `space-${spaceId}`,
      kind: "space-cohort",
      confidence: "low",
      app_ids: appIds.sort(compareIds),
      evidence: [`同属 Space ${spaceId}；未发现足以证明系统边界的显式关系`]
    });
  }
  return {
    schema_version: "0.1",
    basis: "仅以已发布 App 的 schema 关系作为硬证据；Space 仅作低置信辅助分组，不分析记录内容。",
    candidates,
    standalone_app_ids: apps.map(({ id }) => String(id)).filter((id) => !included.has(id)).sort(compareIds)
  };
}
