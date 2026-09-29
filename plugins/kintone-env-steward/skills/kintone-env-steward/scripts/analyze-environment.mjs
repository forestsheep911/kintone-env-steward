#!/usr/bin/env node

import { readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./yaml-lite.mjs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const workspace = path.resolve(option("--workspace") ?? process.cwd());
const environmentId = option("--environment");
if (!environmentId) {
  console.error(
    "Usage: analyze-environment.mjs --environment <id> [--workspace <dir>] [--concurrency 1-10] [--include-admin-ui] [--include-app-settings]",
  );
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const config = parseYaml(
  await readFile(
    path.join(workspace, ".kintone-env-steward", "environments.yaml"),
    "utf8",
  ),
);
const environment = config.environments?.find(({ id }) => id === environmentId);
if (!environment) {
  console.error(`Unknown environment: ${environmentId}`);
  process.exit(1);
}

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
const artifactRoot = path.resolve(workspace, config.engagement.artifactRoot);
const workspaceBoundary = `${workspace}${path.sep}`;
if (!artifactRoot.startsWith(workspaceBoundary)) {
  console.error("engagement.artifactRoot must stay inside the active workspace");
  process.exit(1);
}
const outputDir = path.join(artifactRoot, runId);

function run(script, scriptArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptDir, script), ...scriptArgs], {
      cwd: workspace,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

try {
  const collectorArgs = [
    "--workspace",
    workspace,
    "--environment",
    environmentId,
    "--output",
    outputDir,
    "--run-id", runId,
  ];
  const concurrency = option("--concurrency");
  if (concurrency) collectorArgs.push("--concurrency", concurrency);
  if (option("--resume-from")) collectorArgs.push("--resume-from", option("--resume-from"));
  if (args.includes("--include-admin-ui")) collectorArgs.push("--include-admin-ui");
  if (args.includes("--include-app-settings")) collectorArgs.push("--include-app-settings");
  await run("collect-readonly-snapshot.mjs", collectorArgs);
  const businessSystemMap = path.join(workspace, ".kintone-env-steward", "business-system-map.json");
  let mapArgument = [];
  try { await access(businessSystemMap); mapArgument = ["--business-system-map", businessSystemMap]; }
  catch { /* No reviewed business-system map exists yet. */ }
  await run("build-report-site.mjs", [
    "--snapshot",
    path.join(outputDir, "snapshot.json"),
    "--output",
    path.join(outputDir, "report-site"),
    ...mapArgument,
  ]);
  console.log(`Report site: ${path.join(outputDir, "report-site")}`);
  console.log("Report URL after starting the local server: http://127.0.0.1:4318/");
} catch (error) {
  console.error(`Analysis pipeline failed: ${error.message}`);
  process.exit(1);
}
