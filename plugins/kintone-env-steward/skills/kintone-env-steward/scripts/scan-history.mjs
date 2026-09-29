#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ScanStore, databasePath } from "./scan-store.mjs";

const args = process.argv.slice(2);
const option = (key) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const workspace = path.resolve(option("--workspace") ?? process.cwd());
const filename = databasePath(workspace);
await access(filename);
const store = new ScanStore(filename);
try {
  const runId = option("--run");
  const output = option("--export");
  if (output) {
    if (!runId) throw new Error("--export requires --run");
    const target = path.resolve(workspace, output);
    if (!target.startsWith(workspace + path.sep)) throw new Error("Export must stay inside workspace");
    const snapshot = store.snapshot(runId);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx" });
    console.log(`Snapshot exported: ${target}`);
  } else {
    console.log(JSON.stringify(runId ? store.resources(runId) : store.list().map((run) => ({ ...run, target: JSON.parse(run.target) })), null, 2));
  }
} finally { store.close(); }
