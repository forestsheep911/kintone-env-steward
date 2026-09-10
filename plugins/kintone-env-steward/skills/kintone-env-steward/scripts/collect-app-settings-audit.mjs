const ENDPOINTS = {
  views: "app/views", graphs: "app/reports", customization: "app/customize",
  app_permissions: "app/acl", record_permissions: "record/acl", field_permissions: "field/acl",
  general_notifications: "app/notifications/general", per_record_notifications: "app/notifications/perRecord",
  reminder_notifications: "app/notifications/reminder", actions: "app/actions",
  plugins: "app/plugins", admin_notes: "app/adminNotes"
};

const countBy = (items, key) => Object.fromEntries((items ?? []).reduce((map, item) => {
  const value = String(key(item) ?? "unknown"); map.set(value, (map.get(value) ?? 0) + 1); return map;
}, new Map()));
const entities = (items) => countBy(items, ({ entity }) => entity?.type ?? entity?.entityType);
const listValues = (value) => Object.values(value ?? {});
const summarizePermission = (response, appLevel = false) => {
  const rights = response.rights ?? [];
  const enabled = appLevel ? Object.fromEntries(["appEditable", "recordViewable", "recordAddable", "recordEditable", "recordDeletable", "recordImportable", "recordExportable"].map((key) => [key, rights.filter((right) => right[key] === true).length])) : undefined;
  const everyone = rights.filter(({ entity }) => entity?.type === "GROUP" && String(entity?.code).toLowerCase() === "everyone");
  const everyoneEnabled = appLevel ? Object.fromEntries(["appEditable", "recordViewable", "recordAddable", "recordEditable", "recordDeletable", "recordImportable", "recordExportable"].map((key) => [key, everyone.filter((right) => right[key] === true).length])) : undefined;
  return { rule_count: rights.length, entity_types: entities(rights), everyone_rule_count: everyone.length, ...(enabled ? { permission_rule_counts: enabled, everyone_permission_rule_counts: everyoneEnabled } : {}) };
};
const summarizeNotifications = (response) => ({ rule_count: (response.notifications ?? []).length, entity_types: entities(response.notifications), notify_to_commenter: response.notifyToCommenter ?? null });
const hosts = (files) => [...new Set((files ?? []).map(({ url }) => { try { return new URL(url).host; } catch { return null; } }).filter(Boolean))].sort();

function summarize(key, value) {
  if (key === "views") { const views = listValues(value.views); return { count: views.length, types: countBy(views, ({ type }) => type), custom_view_count: views.filter(({ type }) => type === "CUSTOM").length }; }
  if (key === "graphs") { const reports = listValues(value.reports); return { count: reports.length, types: countBy(reports, ({ chartType, type }) => chartType ?? type) }; }
  if (key === "customization") { const desktop = value.desktop ?? {}, mobile = value.mobile ?? {}; return { scope: value.scope ?? null, desktop: { js_count: (desktop.js ?? []).length, css_count: (desktop.css ?? []).length, external_hosts: [...new Set([...hosts(desktop.js), ...hosts(desktop.css)])] }, mobile: { js_count: (mobile.js ?? []).length, css_count: (mobile.css ?? []).length, external_hosts: [...new Set([...hosts(mobile.js), ...hosts(mobile.css)])] } }; }
  if (key === "app_permissions") return summarizePermission(value, true);
  if (["record_permissions", "field_permissions"].includes(key)) return summarizePermission(value);
  if (key.endsWith("notifications")) return summarizeNotifications(value);
  if (key === "actions") return { count: listValues(value.actions).length };
  if (key === "plugins") { const plugins = value.plugins ?? []; return { count: plugins.length, enabled_count: plugins.filter(({ enabled }) => enabled).length }; }
  if (key === "admin_notes") return { present: Boolean(String(value.content ?? "").trim()), length: String(value.content ?? "").length, included_in_template_and_duplicates: value.includeInTemplateAndDuplicates ?? null };
  return {};
}

export async function collectAppSettingsAudit({ baseUrl, authorization, appIds, concurrency = 4 }) {
  const fetchSetting = async (appId, key, endpoint) => {
    const url = new URL(`/k/v1/${endpoint}.json`, baseUrl); url.searchParams.set("app", appId);
    const response = await fetch(url, { headers: { "X-Cybozu-Authorization": authorization } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return summarize(key, await response.json());
  };
  const byApp = {}, unknowns = [];
  for (let index = 0; index < appIds.length; index += concurrency) {
    await Promise.all(appIds.slice(index, index + concurrency).map(async (appId) => {
      const results = await Promise.all(Object.entries(ENDPOINTS).map(async ([key, endpoint]) => {
        try { return [key, await fetchSetting(appId, key, endpoint)]; }
        catch (error) { unknowns.push({ appId, source: `rest-${key}`, error: error.message }); return [key, null]; }
      }));
      byApp[appId] = Object.fromEntries(results);
    }));
  }
  return { byApp, unknowns };
}
