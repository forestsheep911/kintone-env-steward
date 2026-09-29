import test from "node:test";
import assert from "node:assert/strict";
import { buildReportModel } from "../plugins/kintone-env-steward/skills/kintone-env-steward/scripts/report-model.mjs";
import { deriveSystemClusters } from "../plugins/kintone-env-steward/skills/kintone-env-steward/scripts/derive-system-clusters.mjs";
import { parseCsv, pageJson, validateJsonResource, summarizeCommonLicense, summarizeSharedSettings, summarizeDirectory } from "../plugins/kintone-env-steward/skills/kintone-env-steward/scripts/collect-admin-ui-derived.mjs";
import { summarize } from "../plugins/kintone-env-steward/skills/kintone-env-steward/scripts/collect-app-settings-audit.mjs";

const fixture = () => ({ target: { environment_id: "A" }, assets: { apps: [{ appId: "1", name: "Fixture" }] }, configurations: { "1": { process: { enable: true }, audit: {} } } });
const has = (snapshot, id, options) => buildReportModel(snapshot, options).findings.some((finding) => finding.id === id);

test("Japanese directory normalizes reviewed headers and lifecycle/customization flags", () => {
  const csv = 'ID,アプリ名,ステータス,レコード数,フィールド数,APIトークン数,Webhook数,添付ファイルの合計サイズ（byte）,カスタマイズ,このアプリを参照しているアプリ数\n1,Fixture,運用開始前,0,0,0,0,0,あり,0';
  const row = parseCsv(csv)[0];
  assert.equal(row["应用名称"], "Fixture");
  assert.equal(row["状态"], "未启用");
  assert.equal(row["自定义"], "有");
  assert.equal(parseCsv(csv.replace('あり', 'なし'))[0]["自定义"], "无");
  assert.throws(() => parseCsv(csv.replace('あり', 'unexpected')), /Unrecognized/);
});

test("common license uses its own reviewed count fields and drops other values", () => {
  const result = Object.fromEntries(['Guest','MaxGuest','Space','MaxSpace','GuestSpace','MaxGuestSpace','App','MaxApp','Record','MaxRecord','Field','MaxField','ApiRequest','MaxApiRequest'].map((key) => [`count${key}`, '12']));
  result.secret = 'never-copy';
  const summary = summarizeCommonLicense({ result });
  assert.equal(summary.usedAppCount, 12);
  assert.equal(Object.keys(summary).length, 14);
  assert.equal(summary.secret, undefined);
  delete result.countApp;
  assert.throws(() => summarizeCommonLicense({ result }), /Unrecognized/);
});

test("missing directory counts retain valid rows and never imply a cleanup candidate", () => {
  const row = { ID:'1', '应用名称':'Fixture', '状态':'未启用', '自定义':'无', '记录数':'0', '字段数':'0', 'API令牌数':'0', 'Webhook数':'0', '附件的总大小（byte）':'0', '参照了此应用的应用数':'' };
  const result = summarizeDirectory([row]);
  assert.equal(result.app_count, 1);
  assert.equal(result.apps[0].inbound_references, null);
  assert.equal(result.cleanup_candidate_count, 0);
  assert.equal(result.missing_numeric_count, 1);
  row['记录数'] = '';
  assert.equal(summarizeDirectory([row]).totals.records, null);
});

test("shared settings reads list settings, retaining explicit false", () => {
  const settings = { prohibitGrantAppManagementPermissionToEveryoneGroup: false, prohibitGrantExportRecordsPermissionToEveryoneGroup: true };
  assert.deepEqual(summarizeSharedSettings({ result: { settings } }), { prohibit_everyone_app_management: false, prohibit_everyone_record_export: true });
  assert.throws(() => summarizeSharedSettings({ result: {} }), /Unrecognized/);
});

test("REST summaries distinguish empty settings from unrecognized responses", () => {
  for (const key of ["views", "graphs", "app_permissions", "record_permissions", "field_permissions", "actions", "plugins", "general_notifications", "per_record_notifications", "reminder_notifications", "admin_notes", "customization"]) {
    assert.throws(() => summarize(key, {}), /Unrecognized/);
  }
  assert.equal(summarize("general_notifications", { notifications: [] }).rule_count, 0);
  assert.equal(summarize("admin_notes", { content: "" }).present, false);
  assert.equal(summarize("record_permissions", { rights: [] }).rule_count, 0);
});

test("notification finding requires all three collected counts", () => {
  const s = fixture();
  assert.equal(has(s, "GOV-OPS-002"), false);
  assert.equal(buildReportModel(s).apps[0].audit.notificationRuleCount, null);
  for (const key of ["general_notifications", "per_record_notifications", "reminder_notifications"]) s.configurations["1"].audit[key] = { rule_count: 0 };
  assert.equal(has(s, "GOV-OPS-002"), true);
  s.configurations["1"].audit.reminder_notifications = null;
  assert.equal(has(s, "GOV-OPS-002"), false);
  s.configurations["1"].audit.reminder_notifications = { rule_count: 1 };
  assert.equal(has(s, "GOV-OPS-002"), false);
});

test("only a matching environment can apply a reviewed delete exception", () => {
  const s = fixture();
  s.configurations["1"].audit = { app_permissions: { everyone_permission_rule_counts: { recordDeletable: 1 } }, record_permissions: { rule_count: 0 } };
  const map = { environment_id: "B", systems: [{ status: "confirmed", app_ids: ["1"], policy: { allow_everyone_record_delete: true } }] };
  assert.equal(has(s, "GOV-PERM-004"), true);
  assert.throws(() => buildReportModel(s, { businessSystemMap: map }), /environment/);
  map.environment_id = "A";
  assert.equal(has(s, "GOV-PERM-004", { businessSystemMap: map }), false);
  delete map.environment_id;
  assert.throws(() => buildReportModel(s, { businessSystemMap: map }), /environment/);
});

test("unknown notes and audit recipients do not mean absent", () => {
  const s = fixture();
  s.configurations["1"].audit.plugins = { count: 1 };
  s.admin_ui_coverage = { common_admin: { security_audit: { audit: {} } } };
  assert.equal(has(s, "GOV-CUST-003"), false);
  assert.equal(has(s, "GOV-AUDIT-002"), false);
  s.configurations["1"].audit.admin_notes = { present: false };
  s.admin_ui_coverage.common_admin.security_audit.audit = { critical_notification_configured: false, information_notification_configured: false };
  assert.equal(has(s, "GOV-CUST-003"), true);
  assert.equal(has(s, "GOV-AUDIT-002"), true);
});

test("cluster identity survives ordering and addition of larger components", () => {
  const apps = [{ id: "1", relationships: [{ relatedApp: "2" }] }, { id: "2" }];
  const id = deriveSystemClusters(apps).candidates[0].id;
  const expanded = [...apps, { id: "3", relationships: [{ relatedApp: "4" }, { relatedApp: "5" }] }, { id: "4" }, { id: "5" }];
  assert.equal(deriveSystemClusters(expanded.reverse()).candidates.find((c) => c.app_ids.includes("1")).id, id);
});

test("legacy map labels match membership instead of ordinal IDs", () => {
  const s = fixture();
  s.assets.apps.push({ appId: "2", name: "Second" });
  s.configurations["1"].fields = { properties: { ref: { type: "SINGLE_LINE_TEXT", lookup: { relatedApp: { app: "2" } } } } };
  const map = { environment_id: "A", systems: [{ id: "relationship-1", app_ids: ["3", "4"], name: "Wrong", status: "confirmed" }] };
  assert.equal(buildReportModel(s, { businessSystemMap: map }).systemClusters.candidates[0].name, undefined);
  map.systems[0].app_ids = ["2", "1"];
  map.systems[0].name = "Reviewed";
  assert.equal(buildReportModel(s, { businessSystemMap: map }).systemClusters.candidates[0].name, "Reviewed");
});

test("admin parsing rejects login pages, missing markers and unexpected JSON", () => {
  assert.throws(() => parseCsv("<html>Login</html>"), /CSV/);
  assert.throws(() => pageJson("<html>Login</html>", "TOTP_ENABLED"), /Missing/);
  assert.throws(() => pageJson("cybozu.data.page['TOTP_ENABLED'] = nope;", "TOTP_ENABLED"), /Invalid/);
  assert.equal(pageJson("cybozu.data.page['TOTP_ENABLED'] = false;", "TOTP_ENABLED"), false);
  assert.throws(() => validateJsonResource("guest_auth", '{"result":{}}'), /shape/);
  assert.doesNotThrow(() => validateJsonResource("guest_auth", '{"result":{"useTwoStepVerify":false}}'));
  const headers = "ID,应用名称,状态,记录数,字段数,API令牌数,Webhook数,附件的总大小（byte）,自定义,参照了此应用的应用数";
  assert.deepEqual(parseCsv(headers), []);
  assert.equal(parseCsv('\uFEFF' + headers + '\n1,"App, one",未启用,0,0,0,0,0,无,0')[0]["应用名称"], "App, one");
});
