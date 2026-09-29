import { CollectionError } from "./collection-runtime.mjs";

export const INVENTORY_KEY = "mcp:inventory:v2";
export async function collectInventory(callTool, appScope) {
  const apps = [];
  const seen = new Set();
  for (let offset = 0; ; offset += 100) {
    const all = appScope.includes("*");
    const ids = appScope.slice(offset, offset + 100);
    if (!all && !ids.length) break;
    const page = await callTool("kintone-get-apps", all ? { offset, limit: 100 } : { ids, limit: 100 });
    if (!Array.isArray(page?.apps) || page.apps.length > 100) throw new CollectionError("parse-failed", "Invalid inventory page");
    for (const app of page.apps) {
      const id = String(app.appId);
      if (!/^[1-9][0-9]*$/.test(id) || seen.has(id) || (!all && !ids.includes(id))) {
        throw new CollectionError("parse-failed", "Invalid or duplicate inventory App ID");
      }
      seen.add(id); apps.push(app);
    }
    if (all && page.apps.length < 100) break;
  }
  return { apps, unknowns: appScope.includes("*") ? [] : appScope.filter((id) => !seen.has(id)).map((appId) => ({
    appId, source: "app-inventory", error: "Configured App ID was not returned; inaccessible or absent",
  })) };
}

export async function persistedInventory(store, run, callTool, scope) {
  // Only a fully completed directory may be reused. Never cache individual pages.
  const canResume = store.hasComplete(run.resumeFrom, INVENTORY_KEY);
  const effectiveRun = canResume ? run : { ...run, resumeFrom: null };
  const inventory = await store.capture(effectiveRun, INVENTORY_KEY, () => collectInventory(callTool, scope));
  return { inventory, effectiveRun };
}
