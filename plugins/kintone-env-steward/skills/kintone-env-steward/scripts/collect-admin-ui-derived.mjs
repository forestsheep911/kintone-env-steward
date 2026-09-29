#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseYaml } from "./yaml-lite.mjs";
import { readResponse, failureStatus, safeFailure } from "./collection-runtime.mjs";

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
  { key: "shared_app_settings", method: "POST", path: "/k/api/admin/system/sharedappsettings/list.json" },
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
export const ADMIN_RESOURCE_KEYS = SAFE_RESOURCES.map(({ key }) => key);

const JSON_FIELDS = {
  system_customization: ["active", "executable", "scripts"],
  system_plugins: ["marketPlugins", "importPlugins", "appMap", "available"],
  space_capacity: ["maxSpaceCount", "usedSpaceCount", "maxGuestSpaceCount", "usedGuestSpaceCount"],
  guest_capacity: ["countMaxGuest", "countPaid", "countTrial"],
  guest_count: ["count"], guest_auth: ["useTwoStepVerify"],
  shared_app_settings: ["settings"],
  system_monitoring: ["delaySeconds"], mobile_view: ["mobileViewType", "mobileViewSelectableByUser"],
  feature_settings: ["featureSetting"], header_appearance: ["headerColorKdsAppliedEnabled"],
  update_options: ["updateOptions", "updateChannel", "newFeatureDisabledByDefault"]
};

export function validateJsonResource(key, text) {
  const value = JSON.parse(text);
  const payload = value?.result;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      !JSON_FIELDS[key].every((field) => payload[field] != null)) {
    throw new Error(`Unrecognized reviewed JSON shape: ${key}`);
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseCsv(text) {
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
  headers[0] = headers[0]?.replace(/^\uFEFF/, "");
  const japaneseColumns = {
    "アプリ名": "应用名称", "ステータス": "状态", "所属スペース": "所属空间",
    "レコード数": "记录数", "フィールド数": "字段数", "1日のAPIリクエスト数": "API日访问量",
    "APIトークン数": "API令牌数", "Webhook数": "Webhook数",
    "添付ファイルの合計サイズ（byte）": "附件的总大小（byte）", "カスタマイズ": "自定义",
    "このアプリを参照しているアプリ数": "参照了此应用的应用数"
  };
  for (let i = 0; i < headers.length; i++) headers[i] = japaneseColumns[headers[i]] ?? headers[i];
  const required = ["ID", "应用名称", "状态", "记录数", "字段数", "API令牌数", "Webhook数", "附件的总大小（byte）", "自定义", "参照了此应用的应用数"];
  if (!required.every((key) => headers.includes(key))) {
    throw new Error("Unrecognized App directory CSV columns or locale");
  }
  if (data.some((cells) => cells.length !== headers.length)) throw new Error("Malformed App directory CSV row");
  return data.map((cells) => {
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
    if (row["状态"] === "運用開始前") row["状态"] = "未启用";
    if (row["自定义"] === "あり") row["自定义"] = "有";
    if (row["自定义"] === "なし") row["自定义"] = "无";
    if (!["有", "无"].includes(row["自定义"])) throw new Error("Unrecognized directory customization flag");
    return row;
  });
}

function number(cell) {
  if (cell == null || String(cell).trim() === "") return null;
  const parsed = Number(String(cell ?? "").replaceAll(",", ""));
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Invalid directory numeric value");
  return parsed;
}

export function summarizeDirectory(rows) {
  const stateKey = "状态";
  const columns = ["ID", "应用名称", stateKey, "所属空间", "记录数", "字段数", "API日访问量", "API令牌数", "Webhook数", "附件的总大小（byte）", "自定义", "参照了此应用的应用数"];
  const states = Object.fromEntries(rows.reduce((counts, row) => {
    const state = row[stateKey] || "未知";
    counts.set(state, (counts.get(state) ?? 0) + 1);
    return counts;
  }, new Map()));
  const value = (row, key) => number(row[key]);
  const numericColumns = ["记录数", "字段数", "API令牌数", "Webhook数", "附件的总大小（byte）", "参照了此应用的应用数"];
  const missingNumericCount = rows.reduce((sum, row) => sum + numericColumns.filter((key) => value(row, key) === null).length, 0);
  const total = (key) => rows.some((row) => value(row, key) === null) ? null : rows.reduce((sum, row) => sum + value(row, key), 0);
  const candidates = rows.filter((row) => {
    const state = row[stateKey];
    return state === "未启用" && value(row, "字段数") === 0 && value(row, "记录数") === 0 && value(row, "API令牌数") === 0 && value(row, "参照了此应用的应用数") === 0 && String(row["自定义"] ?? "").trim() !== "有";
  });
  return {
    columns: columns.filter((key) => rows.some((row) => key in row)),
    app_count: rows.length,
    missing_numeric_count: missingNumericCount,
    states,
    totals: {
      records: total("记录数"), fields: total("字段数"), api_tokens: total("API令牌数"),
      webhooks: total("Webhook数"), attachment_bytes: total("附件的总大小（byte）")
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

export function pageJson(html, key) {
  const marker = `cybozu.data.page['${key}'] =`;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`Missing reviewed page data: ${key}`);
  const end = html.indexOf(";", start + marker.length);
  if (end < 0) throw new Error(`Unterminated reviewed page data: ${key}`);
  try { return JSON.parse(html.slice(start + marker.length, end).trim()); }
  catch { throw new Error(`Invalid reviewed page data: ${key}`); }
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
  const picked = Object.fromEntries(allowed.filter((key) => key in value).map((key) => [key, value[key]]));
  if (!Object.keys(picked).length) throw new Error("Unrecognized capacity response");
  return picked;
}

export function summarizeCommonLicense(value) {
  const payload = value?.result;
  const mapping = { countGuest: "usedGuestCount", countMaxGuest: "maxGuestCount",
    countSpace: "usedSpaceCount", countMaxSpace: "maxSpaceCount",
    countGuestSpace: "usedGuestSpaceCount", countMaxGuestSpace: "maxGuestSpaceCount",
    countApp: "usedAppCount", countMaxApp: "maxAppCount", countRecord: "usedRecordCount",
    countMaxRecord: "maxRecordCount", countField: "usedFieldCount", countMaxField: "maxFieldCount",
    countApiRequest: "usedApiRequestCount", countMaxApiRequest: "maxApiRequestCount" };
  if (!payload || !Object.keys(mapping).every((key) => /^(?:[0-9]+|-1)$/.test(String(payload[key])))) {
    throw new Error("Unrecognized common license response");
  }
  return Object.fromEntries(Object.entries(mapping).map(([key, output]) => [output, Number(payload[key])]));
}

export function summarizeSharedSettings(value) {
  const settings = value?.result?.settings;
  const management = settings?.prohibitGrantAppManagementPermissionToEveryoneGroup;
  const recordExport = settings?.prohibitGrantExportRecordsPermissionToEveryoneGroup;
  if (typeof management !== "boolean" || typeof recordExport !== "boolean") throw new Error("Unrecognized shared App settings response");
  return { prohibit_everyone_app_management: management, prohibit_everyone_record_export: recordExport };
}

function configured(value) {
  if (value == null) throw new Error("Missing reviewed audit setting");
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

export async function collectAdminUiDerived({ workspace, environmentId, outputDir, checkpoint = () => {} }) {
  const config = parseYaml(await readFile(path.join(workspace, ".kintone-env-steward", "environments.yaml"), "utf8"));
  const environment = config.environments?.find(({ id }) => id === environmentId);
  if (!environment) throw new Error(`Unknown environment: ${environmentId}`);
  const credentials = JSON.parse(await readFile(path.join(workspace, ".kintone-env-steward", "credentials.local.json"), "utf8"));
  const saved = credentials.credentials?.[environmentId] ?? {};
  if (!saved.username || !saved.password) throw new Error("UI-derived collection requires locally configured username and password");
  const authorization = Buffer.from(`${saved.username}:${saved.password}`, "utf8").toString("base64");
  const request = async (resource) => {
    return readResponse(new URL(resource.path, environment.baseUrl), {
      method: resource.method, headers: { "X-Cybozu-Authorization": authorization, "Content-Type": "application/json" },
      body: resource.method === "POST" ? "{}" : undefined, redirect: "manual"
    });
  };

  const unknowns = [], coverage = [];
  let directory = null, capacity = null, system = null, common = null;
  for (const resource of SAFE_RESOURCES) {
    try {
      const response = await request(resource);
      if (JSON_FIELDS[resource.key]) validateJsonResource(resource.key, response.text);
      if (resource.key === "app_directory") {
        directory = summarizeDirectory(parseCsv(response.text));
        if (directory.missing_numeric_count) unknowns.push({ source: "app_directory", error: `${directory.missing_numeric_count} numeric directory value(s) missing; preserved as unknown, not zero` });
      }
      else if (resource.key === "app_capacity") capacity = pickCapacity(JSON.parse(response.text));
      else if (resource.key === "common_license") common = { ...(common ?? {}), license: summarizeCommonLicense(JSON.parse(response.text)) };
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
        system = { ...(system ?? {}), shared_app_settings: summarizeSharedSettings(JSON.parse(response.text)) };
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
      const status = resource.key === "api_tokens" ? "unsupported" : resource.key === "system_admin" || (resource.key === "app_directory" && directory.missing_numeric_count) ? "partial" : "complete";
      coverage.push({ resource: resource.key, status, response_shape: resource.key.includes("admin") ? "HTML or reviewed JSON" : "CSV or JSON" });
      checkpoint(resource.key, status, { app_directory: resource.key === "app_directory" ? directory : null,
        capacity: resource.key === "app_capacity" ? capacity : null, system_admin: system, common_admin: common });
    } catch (error) {
      coverage.push({ resource: resource.key, status: failureStatus(error) });
      unknowns.push({ source: resource.key, error: safeFailure(error) });
      checkpoint(resource.key, failureStatus(error), null);
    }
  }
  if (directory) directory.capacity = capacity;
  const snapshot = { schema_version: "0.2", source: "ui-derived", collected_at: new Date().toISOString(), status: unknowns.length ? "partial" : "complete", coverage, app_directory: directory, system_admin: system, common_admin: common, unknowns };
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
