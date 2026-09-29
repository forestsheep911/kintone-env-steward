import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ScanStore } from "../plugins/kintone-env-steward/skills/kintone-env-steward/scripts/scan-store.mjs";

const target = { environmentId: "fixture", baseUrl: "https://fixture.invalid", appScope: ["1"], includeAdminUi: false, includeAppSettings: false };
test("durable partial collection resumes in a new isolated run and exports snapshots", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "steward-store-"));
  const filename = path.join(dir, "scans.sqlite");
  let store = new ScanStore(filename);
  try {
    const first = store.start("first", target);
    await store.capture(first, "fields:1", async () => ({ fields: [] }));
    await assert.rejects(store.capture(first, "layout:1", async () => { throw new Error("secret server response"); }));
    store.close();
    store = new ScanStore(filename);
    assert.equal(store.list()[0].status, "running");
    assert.equal(store.resources("first").length, 2);
    assert.throws(() => store.start("wrong", { ...target, baseUrl: "https://other.invalid" }, "first"), /match/);
    assert.throws(() => store.start("wrong", { ...target, includeAppSettings: true }, "first"), /match/);
    const resumed = store.start("second", target, "first");
    const cached = await store.capture(resumed, "fields:1", async () => { throw new Error("must not fetch"); });
    assert.deepEqual(cached, { fields: [] });
    let retried = false;
    await store.capture(resumed, "layout:1", async () => { retried = true; return { layout: [] }; });
    assert.equal(retried, true);
    const snapshot = { run_id: "second", assets: { apps: [] } };
    store.finish("second", "complete", snapshot);
    assert.deepEqual(store.snapshot("second"), snapshot);
    assert.equal(store.resources("first").find((r) => r.key === "layout:1").status, "failed");
    assert.equal(store.resources("second").find((r) => r.key === "fields:1").reused_from, "first");
    assert.equal(store.db.prepare("SELECT error FROM resources WHERE status='failed'").get().error.includes("secret"), false);
    assert.throws(() => store.start("second", target), /UNIQUE/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("history export feeds the existing HTML report builder", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "steward-export-"));
  const store = new ScanStore(path.join(dir, ".kintone-env-steward", "scans.sqlite"));
  const scripts = path.resolve("plugins/kintone-env-steward/skills/kintone-env-steward/scripts");
  try {
    store.start("export-test", target);
    store.finish("export-test", "complete", { run_id: "export-test", target: { environment_id: "fixture" }, assets: { apps: [] } });
    const exported = spawnSync(process.execPath, [path.join(scripts, "scan-history.mjs"), "--workspace", dir, "--run", "export-test", "--export", "outputs/snapshot.json"], { encoding: "utf8" });
    assert.equal(exported.status, 0, exported.stderr);
    const built = spawnSync(process.execPath, [path.join(scripts, "build-report-site.mjs"), "--snapshot", path.join(dir, "outputs/snapshot.json")], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const report = JSON.parse(readFileSync(path.join(dir, "outputs/report-site/report-data.json"), "utf8"));
    assert.equal(report.source.runId, "export-test");
    assert.equal(report.metrics.appCount, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
