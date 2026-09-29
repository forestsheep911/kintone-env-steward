import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { failureStatus, safeFailure } from "./collection-runtime.mjs";

export const databasePath = (workspace) => path.join(workspace, ".kintone-env-steward", "scans.sqlite");
const canonicalTarget = (target) => JSON.stringify({
  environmentId: target.environmentId, baseUrl: target.baseUrl,
  appScope: [...target.appScope].map(String).sort(),
  includeAdminUi: Boolean(target.includeAdminUi), includeAppSettings: Boolean(target.includeAppSettings),
});

export class ScanStore {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > 1) { this.db.close(); throw new Error("Unsupported scan database version"); }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT, status TEXT NOT NULL, resumed_from TEXT REFERENCES runs(id),
        snapshot TEXT
      );
      CREATE TABLE IF NOT EXISTS resources (
        run_id TEXT NOT NULL REFERENCES runs(id), key TEXT NOT NULL,
        status TEXT NOT NULL, collected_at TEXT NOT NULL,
        data TEXT, error TEXT, reused_from TEXT,
        PRIMARY KEY(run_id, key)
      );
      CREATE INDEX IF NOT EXISTS resources_status ON resources(run_id, status);
      PRAGMA user_version=1;
    `);
  }
  start(runId, target, resumeFrom = null) {
    const encoded = canonicalTarget(target);
    if (resumeFrom) {
      const previous = this.db.prepare("SELECT target FROM runs WHERE id=?").get(resumeFrom);
      if (!previous || previous.target !== encoded) throw new Error("Resume run must exist and match environment, domain, scope and collection options");
    }
    this.db.prepare("INSERT INTO runs(id,target,started_at,status,resumed_from) VALUES(?,?,?,'running',?)")
      .run(runId, encoded, new Date().toISOString(), resumeFrom);
    return { runId, resumeFrom };
  }
  async capture(run, key, collect) {
    const old = run.resumeFrom && this.db.prepare("SELECT * FROM resources WHERE run_id=? AND key=? AND status='complete'").get(run.resumeFrom, key);
    if (old) {
      this.save(run.runId, key, "complete", JSON.parse(old.data), old.collected_at, run.resumeFrom);
      return JSON.parse(old.data);
    }
    try {
      const data = await collect();
      if (data === undefined) throw new Error("Collector returned no evidence");
      this.save(run.runId, key, "complete", data);
      return data;
    } catch (error) {
      // Do not persist arbitrary server error bodies or credential-bearing URLs.
      this.save(run.runId, key, failureStatus(error), null, undefined, null, safeFailure(error));
      throw error;
    }
  }
  hasComplete(runId, key) {
    return Boolean(runId && this.db.prepare("SELECT 1 FROM resources WHERE run_id=? AND key=? AND status='complete'").get(runId, key));
  }
  plan(runId, keys) {
    const insert = this.db.prepare("INSERT OR IGNORE INTO resources VALUES(?,?,'not-collected',?,NULL,NULL,NULL)");
    for (const key of keys) insert.run(runId, key, new Date().toISOString());
  }
  save(runId, key, status, data, time = new Date().toISOString(), reusedFrom = null, error = null) {
    this.db.prepare("INSERT OR REPLACE INTO resources VALUES(?,?,?,?,?,?,?)")
      .run(runId, key, status, time, JSON.stringify(data), error ?? (status === "failed" ? "Collection failed; retry required" : null), reusedFrom);
  }
  finish(runId, status, snapshot = null) {
    this.db.prepare("UPDATE runs SET status=?,finished_at=?,snapshot=? WHERE id=?")
      .run(status, new Date().toISOString(), snapshot ? JSON.stringify(snapshot) : null, runId);
  }
  list() {
    return this.db.prepare("SELECT id,target,started_at,finished_at,status,resumed_from FROM runs ORDER BY started_at DESC").all();
  }
  resources(runId) {
    return this.db.prepare("SELECT key,status,collected_at,reused_from,error FROM resources WHERE run_id=? ORDER BY key").all(runId);
  }
  snapshot(runId) {
    const row = this.db.prepare("SELECT snapshot FROM runs WHERE id=?").get(runId);
    if (!row?.snapshot) throw new Error("Run has no finalized snapshot");
    return JSON.parse(row.snapshot);
  }
  close() { this.db.close(); }
}
