import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readResponse, CollectionError, sourceStatus } from "../plugins/kintone-env-steward/skills/kintone-env-steward/scripts/collection-runtime.mjs";
import { persistedInventory, INVENTORY_KEY, collectInventory } from "../plugins/kintone-env-steward/skills/kintone-env-steward/scripts/collect-inventory.mjs";
import { ScanStore } from "../plugins/kintone-env-steward/skills/kintone-env-steward/scripts/scan-store.mjs";

test("429 respects Retry-After, transient errors retry, and success returns body", async () => {
  let calls = 0;
  const delays = [];
  const response = await readResponse("https://fixture.invalid", {}, {
    fetchImpl: async () => ++calls === 1 ? new Response("", { status: 429, headers: { "Retry-After": "2" } }) : calls === 2 ? new Response("", { status: 503 }) : new Response("done"),
    sleep: async (delay) => delays.push(delay),
  });
  assert.equal(response.text, "done");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2000, 2000]);
});

test("403 and redirects never retry or forward credentials; long Retry-After stops", async () => {
  for (const status of [403, 302, 429]) {
    let calls = 0;
    await assert.rejects(readResponse("https://fixture.invalid", {}, {
      fetchImpl: async (_url, options) => {
        calls++; assert.equal(options.redirect, "manual");
        return new Response("", { status, headers: { "Retry-After": "120" } });
      }, sleep: async () => assert.fail("must not retry"),
    }), (error) => error.status === (status === 403 ? "forbidden" : "request-failed"));
    assert.equal(calls, 1);
  }
});

test("timeout covers stalled response body and aborts bounded attempts", async () => {
  let calls = 0;
  const signals = [];
  await assert.rejects(readResponse("https://fixture.invalid", {}, {
    timeoutMs: 10, attempts: 2, sleep: async () => {},
    fetchImpl: async (_url, { signal }) => {
      calls++; signals.push(signal);
      return { ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) };
    },
  }), (error) => error.status === "request-failed");
  assert.equal(calls, 2);
  assert.ok(signals.every((signal) => signal.aborted));
});

test("guest-space routing errors remain explicit unsupported evidence without error body", async () => {
  let calls = 0;
  await assert.rejects(readResponse("https://fixture.invalid", {}, {
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({code:'GAIA_IL23', message:'private details'}), {status:400}); },
    sleep: async () => assert.fail('must not retry'),
  }), (error) => error.status === 'unsupported' && !error.message.includes('private'));
  assert.equal(calls, 1);
});

test("coverage distinguishes unattempted, forbidden, parser and request failures per source", async () => {
  const store = new ScanStore(":memory:");
  try {
    const run = store.start("coverage", { environmentId: "test", baseUrl: "https://fixture.invalid", appScope: ["*"] });
    store.plan(run.runId, ["rest:not-started", "mcp:ok"]);
    await store.capture(run, "mcp:ok", async () => ({}));
    for (const status of ["forbidden", "parse-failed", "request-failed"]) {
      await assert.rejects(store.capture(run, `admin-ui:${status}`, async () => { throw new CollectionError(status, "secret"); }));
    }
    store.save(run.runId, "admin-ui:unsupported", "unsupported", null);
    const rows = store.resources(run.runId);
    assert.equal(sourceStatus(rows, "mcp:"), "complete");
    assert.equal(sourceStatus(rows, "rest:"), "not-collected");
    assert.equal(sourceStatus(rows, "admin-ui:"), "partial");
    assert.equal(rows.find((r) => r.key === "rest:not-started").status, "not-collected");
    assert.ok(!JSON.stringify(rows).includes("secret"));
  } finally { store.close(); }
});

test("interrupted directory restarts page zero after reopening database; complete directory freezes on resume", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "steward-pagination-"));
  const filename = path.join(dir, "scan.sqlite");
  let store = new ScanStore(filename);
  const target = { environmentId: "test", baseUrl: "https://fixture.invalid", appScope: ["*"] };
  const page = (start) => ({ apps: Array.from({ length: 100 }, (_, i) => ({ appId: String(start + i), name: "Fixture" })) });
  try {
    const first = store.start("first", target);
    await assert.rejects(persistedInventory(store, first, async (_tool, args) => {
      if (args.offset === 0) return page(1);
      throw new Error("Injected page failure");
    }, ["*"]));
    assert.equal(store.hasComplete("first", INVENTORY_KEY), false);
    store.close(); store = new ScanStore(filename);
    const second = store.start("second", target, "first");
    const offsets = [];
    const result = await persistedInventory(store, second, async (_tool, args) => {
      offsets.push(args.offset);
      return args.offset === 0 ? page(101) : { apps: [{ appId: "201", name: "New" }] };
    }, ["*"]);
    assert.deepEqual(offsets, [0, 100]);
    assert.equal(result.inventory.apps.length, 101);
    assert.equal(result.inventory.apps[0].appId, "101");
    assert.equal(result.effectiveRun.resumeFrom, null);
    const third = store.start("third", target, "second");
    const frozen = await persistedInventory(store, third, async () => assert.fail("must reuse whole directory"), ["*"]);
    assert.deepEqual(frozen.inventory, result.inventory);
    assert.equal(frozen.effectiveRun.resumeFrom, "second");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("missing and duplicate inventory pages cannot be mistaken for successful empty inventory", async () => {
  await assert.rejects(collectInventory(async () => ({}), ["*"]), (e) => e.status === "parse-failed");
  await assert.rejects(collectInventory(async () => ({ apps: [{ appId: "1" }, { appId: "1" }] }), ["*"]), (e) => e.status === "parse-failed");
});

test("abrupt child exit preserves completed and unattempted resources for recovery", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "steward-crash-"));
  const filename = path.join(dir, "scan.sqlite");
  const moduleUrl = pathToFileURL(path.resolve("plugins/kintone-env-steward/skills/kintone-env-steward/scripts/scan-store.mjs")).href;
  const target = { environmentId: "test", baseUrl: "https://fixture.invalid", appScope: ["1"] };
  let store;
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { ScanStore } from ${JSON.stringify(moduleUrl)};
      const store = new ScanStore(${JSON.stringify(filename)});
      const run = store.start('crashed', ${JSON.stringify(target)});
      store.plan(run.runId, ['fields:1', 'layout:1']);
      await store.capture(run, 'fields:1', async () => ({ properties: {} }));
      process.exit(73);
    `], { encoding: "utf8" });
    assert.equal(child.status, 73, child.stderr);
    store = new ScanStore(filename);
    assert.equal(store.list()[0].status, "running");
    assert.equal(store.resources("crashed").find((r) => r.key === "layout:1").status, "not-collected");
    const next = store.start("recovered", target, "crashed");
    await store.capture(next, "fields:1", async () => assert.fail("completed evidence should survive crash"));
    await store.capture(next, "layout:1", async () => ({ layout: [] }));
    assert.ok(store.resources("recovered").every((r) => r.status === "complete"));
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
