#!/usr/bin/env node

import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildReportModel } from "./report-model.mjs";

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const snapshotPath = path.resolve(option("--snapshot") ?? "");
const outputPath = path.resolve(option("--output") ?? "");
if (!option("--snapshot") || !option("--output")) {
  console.error("Usage: initialize-business-system-map.mjs --snapshot <snapshot.json> --output <business-system-map.json>");
  process.exit(2);
}
try {
  await access(outputPath);
  console.error(`Refusing to overwrite existing map: ${outputPath}`);
  process.exit(1);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const report = buildReportModel(snapshot);
const map = {
  schema_version: "0.1",
  environment_id: snapshot.target.environment_id,
  generated_from_run: snapshot.run_id,
  systems: report.systemClusters.candidates.map((candidate) => ({
    id: candidate.id,
    status: "candidate",
    candidate_kind: candidate.kind,
    confidence: candidate.confidence,
    name: null,
    owner: null,
    criticality: "unknown",
    lifecycle: "unknown",
    app_ids: candidate.app_ids,
    evidence: candidate.evidence,
    policy: { allow_everyone_record_delete: null, exception_notes: null }
  })),
  unassigned_app_ids: report.systemClusters.standalone_app_ids
};
await writeFile(outputPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
console.log(`Business system map: ${outputPath}`);
console.log(`Candidates: ${map.systems.length}; unassigned App(s): ${map.unassigned_app_ids.length}`);
