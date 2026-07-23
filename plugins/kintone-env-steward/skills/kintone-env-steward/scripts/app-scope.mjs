const maxAppId = 9223372036854775807n;
const maxExpandedIds = 10000;

export function parseAppScopeExpression(value) {
  const expression = String(value ?? "").trim();
  if (expression === "*") return ["*"];
  if (!expression) throw new Error("App 范围不能为空");

  const ids = new Set();
  for (const rawItem of expression.split(",")) {
    const item = rawItem.trim();
    const match = item.match(/^([1-9][0-9]*)(?:\s*-\s*([1-9][0-9]*))?$/);
    if (!match) {
      throw new Error(`无效的 App ID 或区间：${item || "空项"}`);
    }
    const start = BigInt(match[1]);
    const end = BigInt(match[2] || match[1]);
    if (start > maxAppId || end > maxAppId) {
      throw new Error(`App ID 超出 kintone 支持范围：${item}`);
    }
    if (end < start) {
      throw new Error(`区间终点不能小于起点：${item}`);
    }
    if (end - start + 1n > BigInt(maxExpandedIds)) {
      throw new Error(`单个区间最多展开 ${maxExpandedIds} 个 App ID`);
    }
    for (let id = start; id <= end; id += 1n) {
      ids.add(id.toString());
      if (ids.size > maxExpandedIds) {
        throw new Error(`App 范围最多包含 ${maxExpandedIds} 个 App ID`);
      }
    }
  }
  return [...ids].sort((left, right) => {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
