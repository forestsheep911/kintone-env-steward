#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseYaml } from "./yaml-lite.mjs";

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const workspace = path.resolve(option("--workspace", process.cwd()));
const environmentId = option("--environment");
const requestedAccessMode = option("--mode");
const reason = option("--reason", "聊天中的操作需要调整该环境的访问模式。");
const configDirectory = path.join(workspace, ".kintone-env-steward");
const configPath = path.join(configDirectory, "environments.yaml");
const requestPath = path.join(configDirectory, "access-request.local.json");
const launchPath = path.join(configDirectory, "config-ui.json");

if (!environmentId || !requestedAccessMode) {
  console.error(
    "Usage: node request-access-change.mjs --workspace <path> --environment <id> --mode <read-only|read-write> [--reason <text>]",
  );
  process.exit(2);
}
if (!["read-only", "read-write"].includes(requestedAccessMode)) {
  console.error("--mode must be read-only or read-write");
  process.exit(2);
}
if (typeof reason !== "string" || reason.trim() === "" || reason.length > 1000) {
  console.error("--reason must contain 1 to 1000 characters");
  process.exit(2);
}

let config;
try {
  config = parseYaml(await readFile(configPath, "utf8"));
} catch (error) {
  console.error(`Cannot read ${configPath}: ${error.message}`);
  process.exit(1);
}

const environment = config.environments?.find((item) => item.id === environmentId);
if (!environment) {
  console.error(`Unknown environment: ${environmentId}`);
  process.exit(1);
}
if (environment.accessMode === requestedAccessMode) {
  console.log(
    `${environment.label} already uses ${requestedAccessMode}; no confirmation is needed.`,
  );
  process.exit(0);
}

try {
  await stat(requestPath);
  console.error(`A permission confirmation is already pending: ${requestPath}`);
  process.exit(1);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const request = {
  id: randomUUID(),
  environmentId,
  requestedAccessMode,
  reason: reason.trim(),
  requestedAt: new Date().toISOString(),
};

await mkdir(configDirectory, { recursive: true });
const temporaryPath = path.join(
  configDirectory,
  `access-request.${process.pid}.tmp`,
);
await writeFile(temporaryPath, `${JSON.stringify(request, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
await rename(temporaryPath, requestPath);

let url = "http://127.0.0.1:4317/";
try {
  const launch = JSON.parse(await readFile(launchPath, "utf8"));
  if (typeof launch.url === "string") url = launch.url;
} catch {
  // Use the default loopback URL when the launch record is unavailable.
}

console.log(`Permission confirmation requested for ${environment.label}.`);
console.log(`Open or return to: ${url}`);
