#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildReportModel } from "./report-model.mjs";

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const snapshotPath = path.resolve(option("--snapshot") ?? "");
if (!option("--snapshot")) {
  console.error("Usage: build-report-site.mjs --snapshot <snapshot.json> [--output <dir>]");
  process.exit(2);
}

const outputDir = path.resolve(
  option("--output") ?? path.join(path.dirname(snapshotPath), "report-site"),
);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.resolve(scriptDir, "../assets/report-ui");

try {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const report = buildReportModel(snapshot);
  await mkdir(outputDir, { recursive: true });
  await cp(templateDir, outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "report-data.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log(`Report site generated: ${outputDir}`);
  console.log(`Apps: ${report.metrics.appCount}; findings: ${report.findings.length}`);
} catch (error) {
  console.error(`Unable to build report site: ${error.message}`);
  process.exit(1);
}
