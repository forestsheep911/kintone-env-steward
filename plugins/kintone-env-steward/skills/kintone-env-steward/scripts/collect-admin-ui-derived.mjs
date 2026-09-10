#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseYaml } from "./yaml-lite.mjs";

const SAFE_RESOURCES = [
  { key: "app_directory", method: "GET", path: "/k/api/dev/app/mgmt/exportCsv.do?manuallyFetched=false" },
  { key: "app_capacity", method: "POST", path: "/k/api/app/mgmt/countLicense.json" },
  { key: "system_admin", method: "GET", path: "/k/admin/system/" },
  { key: "system_customization", method: "POST", path: "/k/api/js/getSystemSetting.json" },
  { key: "system_plugins", method: "POST", path: "/k/api/dev/plugin/list.json" },
  { key: "space_capacity", method: "POST", path: "/k/api/space/countLicense.json" },
  { key: "guest_capacity", method: "POST", path: "/k/api/guest/countLicense.json" },
  { key: "guest_count", method: "POST", path: "/k/api/guest/count.json" },
  { key: "guest_auth", method: "POST", path: "/k/api/system/guestauth/initialData.json" },
  { key: "shared_app_settings", method: "POST", path: "/k/api/admin/system/sharedappsettings/initialData.json" },
  { key: "system_monitoring", method: "POST", path: "/k/api/monitor/ftsOldestJob.json" },
  { key: "mobile_view", method: "POST", path: "/k/api/system/mobile/initialData.json" },
  { key: "feature_settings", method: "POST", path: "/k/api/system/setting/initialData.json" },
  { key: "header_appearance", method: "POST", path: "/k/api/system/header/initialData.json" },
  { key: "update_options", method: "POST", path: "/k/api/system/newfeature/initialData.json" },
  { key: "common_admin", method: "GET", path: "/admin/" },
  { key: "common_license", method: "POST", path: "/api/accounting/kintoneLicense.json" },
  { key: "audit_settings", method: "GET", path: "/admin/audit/settings" },
  { key: "login_security", method: "GET", path: "/admin/security/login" },
  { key: "oauth_clients", method: "GET", path: "/admin/integrations/oauth/list" },
  { key: "api_tokens", method: "GET", path: "/admin/integrations/apitoken/list" },
  { key: "org_access_control", method: "GET", path: "/admin/orgAccessControl" },
  { key: "administrators", method: "GET", path: "/admin/administrators" },
];

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseCsv(text) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted && char === '"' && text[i + 1] === '"') { value += char; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") { row.push(value); value = ""; }
    else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(value); value = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  const [headers = [], ...data] = rows;
  return data.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
}

function number(cell) {
  const parsed = Number(String(cell ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function summarizeDirectory(rows) {
  const stateKey = "状态";
  const columns = ["ID", "应用名称", stateKey, "所属空间", "记录数", "字段数", "API日访问量", "API令牌数", "Webhook数", "附件的总大小（byte）", "自定义", "参照了此应用的应用数"];
  const states = Object.fromEntries(rows.reduce((counts, row) => {
    const state = row[stateKey] || "未知";
    counts.set(state, (counts.get(state) ?? 0) + 1);
    return counts;
  }, new Map()));
  const value = (row, key) => number(row[key]);
  const candidates = rows.filter((row) => {
    const state = row[stateKey];
    return state === "未启用" && value(row, "字段数") === 0 && value(row, "记录数") === 0 && value(row, "API令牌数") === 0 && value(row, "参照了此应用的应用数") === 0 && String(row["自定义"] ?? "").trim() !== "有";
  });
  return {
    columns: columns.filter((key) => rows.some((row) => key in row)),
    app_count: rows.length,
    states,
    totals: {
      records: rows.reduce((sum, row) => sum + value(row, "记录数"), 0),
      fields: rows.reduce((sum, row) => sum + value(row, "字段数"), 0),
      api_tokens: rows.reduce((sum, row) => sum + value(row, "API令牌数"), 0),
      webhooks: rows.reduce((sum, row) => sum + value(row, "Webhook数"), 0),
      attachment_bytes: rows.reduce((sum, row) => sum + value(row, "附件的总大小（byte）"), 0)
    },
    cleanup_candidate_count: candidates.length,
    cleanup_candidate_criteria: "Unpublished, zero fields, records, API tokens, inbound references, and no customization flag. Confirmation required; never delete automatically.",
    apps: rows.map((row) => ({
      id: String(row.ID ?? ""), name: row["应用名称"] ?? "", state: row[stateKey] ?? "未知",
      space: row["所属空间"] || null, records: value(row, "记录数"), fields: value(row, "字段数"),
      api_tokens: value(row, "API令牌数"), webhooks: value(row, "Webhook数"), attachment_bytes: value(row, "附件的总大小（byte）"),
      customization: String(row["自定义"] ?? "").trim() === "有", inbound_references: value(row, "参照了此应用的应用数")
    }))
  };
}

function pageJson(html, key) {
  const marker = `cybozu.data.page['${key}'] =`;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const end = html.indexOf(";", start + marker.length);
  if (end < 0) return null;
  try { return JSON.parse(html.slice(start + marker.length, end).trim()); }
  catch { return null; }
}

function pageObservation(response, allowedPageData = []) {
  const html = response.text;
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || null;
  const page_data = Object.fromEntries(allowedPageData.map((key) => [key, pageJson(html, key)]).filter(([, value]) => value !== null));
  return { http_status: response.status, title, bytes: Buffer.byteLength(html), response_shape: "HTML page; reviewed allowlisted values only", page_data };
}

function pickCapacity(value) {
  if (value?.result && typeof value.result === "object") value = value.result;
  if (!value || typeof value !== "object") return null;
  const allowed = ["maxAppCount", "usedAppCount", "maxRecordCount", "usedRecordCount", "maxFieldCount", "usedFieldCount", "maxCustomizedAppCount", "usedCustomizedAppCount", "maxSpaceCount", "usedSpaceCount", "maxGuestSpaceCount", "usedGuestSpaceCount", "maxApiRequestCount", "usedApiRequestCount"];
  return Object.fromEntries(allowed.filter((key) => key in value).map((key) => [key, value[key]]));
}

function configured(value) {
  return String(value ?? "").trim().length > 0;
}

function auditSummary(html) {
  const value = pageJson(html, "AUDITLOG_SETTING_DATA") ?? {};
  return {
    retention_period: value.logRetentionPeriod ?? null,
    report_timing: value.reportTiming ?? null,
    critical_actions_configured: configured(value.criticalAction),
    information_actions_configured: configured(value.informationAction),
    critical_notification_configured: configured(value.criticalMailAddresses),
    information_notification_configured: configured(value.informationMailAddresses),
    archive_available: pageJson(html, "AUDITLOG_ARCHIVE_AVAILABLE") ?? null
  };
}

function loginSummary(html) {
  const auto = pageJson(html, "AUTO_LOGIN_SETTINGS") ?? {};
  const screen = pageJson(html, "SCREEN_SETTINGS") ?? {};
  const password = pageJson(html, "PASSWORD_POLICY") ?? {};
  const security = pageJson(html, "LOGIN_SECURITY") ?? {};
  return {
    auto_login_enabled: auto.useAutoLogin ?? null,
    browser_cache_enabled: screen.useBrowserCache ?? null,
    autocomplete_enabled: screen.useAutoComplete ?? null,
    password_policy: {
      min_length: password.minLength ?? null, complexity: password.complexity ?? null,
      expiration: password.expireTime ?? null, history_size: password.historySize ?? null,
      lockout_attempts: password.lockoutAttempts ?? null, lockout_minutes: password.lockoutMinutes ?? null
    },
    force_change_password: security.forceChangePassword ?? null,
    session_timeout_seconds: security.sessionTimeoutSeconds ?? null,
    saml_available: pageJson(html, "SAML_AVAILABLE") ?? null,
    totp_enabled: pageJson(html, "TOTP_ENABLED") ?? null,
    totp_enforced: pageJson(html, "TOTP_ENFORCED") ?? null,
    secure_access_available: pageJson(html, "SECURE_ACCESS_AVAILABLE") ?? null
  };
}

function oauthSummary(html) {
  const builtins = pageJson(html, "BUILTIN_CLIENTS") ?? [];
  const locals = pageJson(html, "LOCAL_CLIENTS") ?? [];
  const slack = pageJson(html, "SLACK_SETTING") ?? {};
  return {
    builtin_client_count: Array.isArray(builtins) ? builtins.length : null,
    local_client_count: Array.isArray(locals) ? locals.length : null,
    slack_enabled: slack.enable ?? null
  };
}

function systemCustomizationSummary(value) {
  const setting = value?.result ?? {};
  return {
    active: setting.active ?? null,
    executable: setting.executable ?? null,
    configurable: setting.configurable ?? null,
    scope: setting.scope ?? null,
    script_count: Array.isArray(setting.scripts) ? setting.scripts.length : null
  };
}

function pluginSummary(value) {
  const result = value?.result ?? {};
  const summarize = (plugins) => {
    const list = Array.isArray(plugins) ? plugins : [];
    return {
      count: list.length,
      installed_count: list.filter((plugin) => plugin.installed === true).length,
      associated_app_count: list.reduce((sum, plugin) => sum + Number(plugin.usingAppCount ?? 0), 0)
    };
  };
  return {
    market: summarize(result.marketPlugins),
    imported: summarize(result.importPlugins),
    app_mapping_count: result.appMap && typeof result.appMap === "object" ? Object.keys(result.appMap).length : null,
    available: result.available ?? null
  };
}

function result(value) {
  return value?.result ?? {};
}

function featureSummary(value) {
  const features = result(value).featureSetting ?? {};
  const flags = Object.entries(features).filter(([, enabled]) => typeof enabled === "boolean");
  return {
    enabled_feature_keys: flags.filter(([, enabled]) => enabled).map(([key]) => key).sort(),
    enabled_count: flags.filter(([, enabled]) => enabled).length,
    disabled_count: flags.filter(([, enabled]) => !enabled).length
  };
}

function updateOptionSummary(value) {
  const setting = result(value);
  const categories = Object.fromEntries(Object.entries(setting.updateOptions ?? {}).map(([category, options]) => {
    const list = Array.isArray(options) ? options : [];
    return [category, { count: list.length, enabled_count: list.filter((option) => option.flagOn).length }];
  }));
  return { update_channel: setting.updateChannel ?? null, new_feature_disabled_by_default: setting.newFeatureDisabledByDefault ?? null, categories };
}

export async function collectAdminUiDerived({ workspace, environmentId, outputDir }) {
  const config = parseYaml(await readFile(path.join(workspace, ".kintone-env-steward", "environments.yaml"), "utf8"));
  const environment = config.environments?.find(({ id }) => id === environmentId);
  if (!environment) throw new Error(`Unknown environment: ${environmentId}`);
  const credentials = JSON.parse(await readFile(path.join(workspace, ".kintone-env-steward", "credentials.local.json"), "utf8"));
  const saved = credentials.credentials?.[environmentId] ?? {};
  if (!saved.username || !saved.password) throw new Error("UI-derived collection requires locally configured username and password");
  const authorization = Buffer.from(`${saved.username}:${saved.password}`, "utf8").toString("base64");
  const request = async (resource) => {
    const response = await fetch(new URL(resource.path, environment.baseUrl), {
      method: resource.method, headers: { "X-Cybozu-Authorization": authorization, "Content-Type": "application/json" },
      body: resource.method === "POST" ? "{}" : undefined, redirect: "manual"
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return { status: response.status, text, contentType: response.headers.get("content-type") ?? "" };
  };

  const unknowns = [], coverage = [];
  let directory = null, capacity = null, system = null, common = null;
  for (const resource of SAFE_RESOURCES) {
    try {
      const response = await request(resource);
      if (resource.key === "app_directory") directory = summarizeDirectory(parseCsv(response.text));
      else if (resource.key === "app_capacity") capacity = pickCapacity(JSON.parse(response.text));
      else if (resource.key === "common_license") common = { ...(common ?? {}), license: pickCapacity(JSON.parse(response.text)) };
      else if (resource.key === "system_admin") {
        system = pageObservation(response);
        unknowns.push({ source: "system_admin", error: "System menu is reachable, but its page-specific settings parsers are not implemented yet" });
      }
      else if (resource.key === "system_customization") {
        system = { ...(system ?? {}), customization: systemCustomizationSummary(JSON.parse(response.text)) };
      }
      else if (resource.key === "system_plugins") {
        system = { ...(system ?? {}), plugins: pluginSummary(JSON.parse(response.text)) };
      }
      else if (resource.key === "space_capacity") {
        const value = result(JSON.parse(response.text));
        system = { ...(system ?? {}), spaces: { ...(system?.spaces ?? {}), max_count: value.maxSpaceCount ?? null, used_count: value.usedSpaceCount ?? null, max_guest_space_count: value.maxGuestSpaceCount ?? null, used_guest_space_count: value.usedGuestSpaceCount ?? null } };
      }
      else if (resource.key === "guest_capacity") {
        const value = result(JSON.parse(response.text));
        system = { ...(system ?? {}), guests: { ...(system?.guests ?? {}), max_count: value.countMaxGuest ?? null, paid_count: value.countPaid ?? null, trial_count: value.countTrial ?? null } };
      }
      else if (resource.key === "guest_count") {
        const value = result(JSON.parse(response.text));
        system = { ...(system ?? {}), guests: { ...(system?.guests ?? {}), count: value.count ?? null } };
      }
      else if (resource.key === "guest_auth") {
        const value = result(JSON.parse(response.text));
        system = { ...(system ?? {}), guests: { ...(system?.guests ?? {}), two_step_verification_enabled: value.useTwoStepVerify ?? null } };
      }
      else if (resource.key === "shared_app_settings") {
        const value = result(JSON.parse(response.text));
        system = { ...(system ?? {}), shared_app_settings: {
          prohibit_everyone_app_management: value.prohibitGrantAppManagementPermissionToEveryoneGroupEnabled ?? null,
          prohibit_everyone_record_export: value.prohibitGrantExportRecordsPermissionToEveryoneGroupEnabled ?? null
        } };
      }
      else if (resource.key === "system_monitoring") {
        const value = result(JSON.parse(response.text));
        system = { ...(system ?? {}), monitoring: { full_text_search_oldest_job_delay_seconds: value.delaySeconds ?? null } };
      }
      else if (resource.key === "mobile_view") {
        const value = result(JSON.parse(response.text));
        system = { ...(system ?? {}), mobile_view: { type: value.mobileViewType ?? null, selectable_by_user: value.mobileViewSelectableByUser ?? null } };
      }
      else if (resource.key === "feature_settings") {
        system = { ...(system ?? {}), feature_settings: featureSummary(JSON.parse(response.text)) };
      }
      else if (resource.key === "header_appearance") {
        const value = result(JSON.parse(response.text));
        system = { ...(system ?? {}), header_appearance: { kds_color_applied: value.headerColorKdsAppliedEnabled ?? null } };
      }
      else if (resource.key === "update_options") {
        system = { ...(system ?? {}), update_options: updateOptionSummary(JSON.parse(response.text)) };
      }
      else if (resource.key === "common_admin") common = {
        ...(common ?? {}),
        ...pageObservation(response, ["DISK_USAGE", "DETAILED_DISK_USAGE", "AVAILABLE_SERVICES", "ACCOUNTING_STATUS"])
      };
      else if (resource.key === "audit_settings") common = { ...(common ?? {}), security_audit: { ...(common?.security_audit ?? {}), audit: auditSummary(response.text) } };
      else if (resource.key === "login_security") common = { ...(common ?? {}), security_audit: { ...(common?.security_audit ?? {}), login: loginSummary(response.text) } };
      else if (resource.key === "oauth_clients") common = { ...(common ?? {}), security_audit: { ...(common?.security_audit ?? {}), integrations: oauthSummary(response.text) } };
      else if (resource.key === "org_access_control") common = { ...(common ?? {}), security_audit: { ...(common?.security_audit ?? {}), organization_access_control_enabled: pageJson(response.text, "USE_ORG_ACCESS_CONTROL") ?? null } };
      else if (resource.key === "administrators") common = { ...(common ?? {}), security_audit: { ...(common?.security_audit ?? {}), administrator_count: Array.isArray(pageJson(response.text, "MEMBER_DATA")) ? pageJson(response.text, "MEMBER_DATA").length : null } };
      else if (resource.key === "api_tokens") {
        common = { ...(common ?? {}), security_audit: { ...(common?.security_audit ?? {}), api_token_coverage: "page-reachable-no-reviewed-list-parser" } };
        unknowns.push({ source: "api_tokens", error: "API token administration page is reachable, but no reviewed token-list parser is implemented" });
      }
      const status = ["system_admin", "api_tokens"].includes(resource.key) ? "partial" : "complete";
      coverage.push({ resource: resource.key, status, response_shape: resource.key.includes("admin") ? "HTML or reviewed JSON" : "CSV or JSON" });
    } catch (error) {
      coverage.push({ resource: resource.key, status: "unavailable" });
      unknowns.push({ source: resource.key, error: error.message });
    }
  }
  if (directory) directory.capacity = capacity;
  const snapshot = { schema_version: "0.1", source: "ui-derived", collected_at: new Date().toISOString(), status: unknowns.length ? "partial" : "complete", coverage, app_directory: directory, system_admin: system, common_admin: common, unknowns };
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "admin-ui-derived.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
}

async function main() {
  const args = process.argv.slice(2);
  const workspace = path.resolve(option(args, "--workspace") ?? process.cwd());
  const environmentId = option(args, "--environment");
  const outputDir = path.resolve(option(args, "--output") ?? workspace);
  if (!environmentId) throw new Error("Usage: collect-admin-ui-derived.mjs --environment <id> [--workspace <dir>] [--output <dir>]");
  const snapshot = await collectAdminUiDerived({ workspace, environmentId, outputDir });
  console.log(`UI-derived collection: ${snapshot.status}; App(s): ${snapshot.app_directory?.app_count ?? 0}; unknown(s): ${snapshot.unknowns.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`UI-derived collection failed: ${error.message}`); process.exit(1); });
}
