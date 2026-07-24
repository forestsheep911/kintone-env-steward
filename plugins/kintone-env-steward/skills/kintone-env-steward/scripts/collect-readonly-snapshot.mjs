#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { parseYaml } from "./yaml-lite.mjs";

const MCP_PACKAGE = "@kintone/mcp-server@1.9.0";
const ALLOWED_TOOLS = new Set([
  "kintone-get-app",
  "kintone-get-apps",
  "kintone-get-form-fields",
  "kintone-get-form-layout",
  "kintone-get-process-management",
  "kintone-get-app-deploy-status",
  "kintone-get-general-settings",
]);
const CONFIG_TOOLS = {
  fields: ["kintone-get-form-fields", (app) => ({ app, lang: "user" })],
  layout: ["kintone-get-form-layout", (app) => ({ app })],
  process: ["kintone-get-process-management", (app) => ({ app, lang: "user" })],
  general: ["kintone-get-general-settings", (app) => ({ app, lang: "user" })],
};

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const workspace = path.resolve(option("--workspace") ?? process.cwd());
const environmentId = option("--environment");
const requestedOutput = option("--output");
const concurrency = Number(option("--concurrency") ?? "4");
if (!environmentId || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
  console.error(
    "Usage: collect-readonly-snapshot.mjs --environment <id> [--workspace <dir>] [--output <dir>] [--concurrency 1-10]",
  );
  process.exit(2);
}

function ensureInsideWorkspace(target, label) {
  const resolved = path.resolve(target);
  const boundary = `${workspace}${path.sep}`;
  if (resolved !== workspace && !resolved.startsWith(boundary)) {
    throw new Error(`${label} must stay inside the active workspace`);
  }
  return resolved;
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function extractStructured(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find(({ type }) => type === "text")?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function credentialEnvironment(method, saved, environment) {
  const env = {
    KINTONE_BASE_URL: environment.baseUrl,
  };
  if (method === "api-token") {
    if (!saved.apiToken) throw new Error("API Token is not configured locally");
    env.KINTONE_API_TOKEN = saved.apiToken;
    return env;
  }
  if (!saved.username || !saved.password) {
    throw new Error("Username or password is not configured locally");
  }
  env.KINTONE_USERNAME = saved.username;
  env.KINTONE_PASSWORD = saved.password;
  if (method === "client-certificate-password") {
    if (!saved.pfxFilePath || !saved.pfxPassword) {
      throw new Error("Client certificate path or password is not configured locally");
    }
    env.KINTONE_PFX_FILE_PATH = saved.pfxFilePath;
    env.KINTONE_PFX_FILE_PASSWORD = saved.pfxPassword;
  }
  return env;
}

function startMcp(extraEnvironment) {
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const childArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", `npx -y ${MCP_PACKAGE}`]
      : ["-y", MCP_PACKAGE];
  const child = spawn(command, childArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...extraEnvironment },
  });

  let buffer = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (value) => {
    stderr += value;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (value) => {
    buffer += value;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  child.on("exit", (code) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`Official MCP exited unexpectedly with code ${code}`));
    }
    pending.clear();
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function request(method, params = {}, timeoutMs = 60_000) {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Official MCP timed out during ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  }
  async function callTool(name, toolArguments) {
    if (!ALLOWED_TOOLS.has(name)) {
      throw new Error(`Tool is outside the Steward read allowlist: ${name}`);
    }
    const result = await request(
      "tools/call",
      { name, arguments: toolArguments },
      90_000,
    );
    if (result?.isError) {
      const message =
        result.content?.find(({ type }) => type === "text")?.text ??
        `Official MCP tool failed: ${name}`;
      throw new Error(message);
    }
    return extractStructured(result);
  }
  async function initialize() {
    await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "kintone-env-steward-readonly-collector",
        version: "0.0.17",
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const listed = await request("tools/list");
    const available = new Set(listed.tools.map(({ name }) => name));
    return available;
  }
  function close() {
    child.stdin.end();
    child.kill();
  }
  function diagnostic() {
    return stderr.trim();
  }
  return { initialize, callTool, close, diagnostic };
}

async function collectApps(callTool, appScope) {
  if (!appScope.includes("*")) {
    const apps = [];
    for (const ids of chunk(appScope, 100)) {
      const page = await callTool("kintone-get-apps", { ids, limit: 100 });
      apps.push(...(page.apps ?? []));
    }
    const returned = new Set(apps.map(({ appId }) => String(appId)));
    const missing = appScope.filter((id) => !returned.has(id));
    return {
      apps,
      unknowns: missing.map((appId) => ({
        appId,
        source: "app-inventory",
        error: "Configured App ID was not returned by kintone-get-apps",
      })),
    };
  }

  const apps = [];
  for (let offset = 0; ; offset += 100) {
    const page = await callTool("kintone-get-apps", { offset, limit: 100 });
    const received = page.apps ?? [];
    apps.push(...received);
    console.log(`Inventory: ${apps.length} App(s)`);
    if (received.length < 100) break;
  }
  return { apps, unknowns: [] };
}

async function collectDeployment(callTool, appIds, unknowns) {
  const results = [];
  for (const apps of chunk(appIds, 300)) {
    try {
      const response = await callTool("kintone-get-app-deploy-status", { apps });
      results.push(...(response.apps ?? []));
    } catch (error) {
      unknowns.push({
        source: "deployment",
        error: error.message,
      });
    }
  }
  return { apps: results };
}

async function main() {
  const configPath = path.join(workspace, ".kintone-env-steward", "environments.yaml");
  const credentialsPath = path.join(
    workspace,
    ".kintone-env-steward",
    "credentials.local.json",
  );
  const config = parseYaml(await readFile(configPath, "utf8"));
  const environment = config.environments?.find(({ id }) => id === environmentId);
  if (!environment) throw new Error(`Unknown environment: ${environmentId}`);
  if (!["read-only", "read-write"].includes(environment.accessMode)) {
    throw new Error(`Unsupported access boundary: ${environment.accessMode}`);
  }
  const credentialStore = JSON.parse(await readFile(credentialsPath, "utf8"));
  if (credentialStore.version !== "1.0") {
    throw new Error("Unsupported local credential store version");
  }
  const saved = credentialStore.credentials?.[environmentId] ?? {};
  const authEnvironment = credentialEnvironment(
    environment.credentialRef?.method,
    saved,
    environment,
  );

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactRoot = ensureInsideWorkspace(
    path.resolve(workspace, config.engagement.artifactRoot),
    "engagement.artifactRoot",
  );
  const outputDir = ensureInsideWorkspace(
    requestedOutput
      ? path.resolve(workspace, requestedOutput)
      : path.join(artifactRoot, runId),
    "snapshot output",
  );

  const mcp = startMcp(authEnvironment);
  try {
    console.log(`Environment: ${environment.id} (${environment.label})`);
    console.log(`Boundary: ${environment.accessMode}; records: not collected`);
    const available = await mcp.initialize();
    const requiredTools = new Set([
      "kintone-get-apps",
      ...Object.values(CONFIG_TOOLS).map(([name]) => name),
      "kintone-get-app-deploy-status",
    ]);
    const missingTools = [...requiredTools].filter((name) => !available.has(name));
    if (missingTools.length) {
      throw new Error(
        `Official MCP did not register required read tools: ${missingTools.join(", ")}`,
      );
    }

    const inventory = await collectApps(mcp.callTool, environment.appScope);
    const apps = inventory.apps;
    const unknowns = inventory.unknowns;
    const configurations = {};
    let completed = 0;

    for (const batch of chunk(apps, concurrency)) {
      await Promise.all(
        batch.map(async ({ appId }) => {
          const entries = await Promise.all(
            Object.entries(CONFIG_TOOLS).map(async ([key, [name, makeArguments]]) => {
              try {
                return [key, await mcp.callTool(name, makeArguments(String(appId)))];
              } catch (error) {
                unknowns.push({
                  appId: String(appId),
                  source: key,
                  error: error.message,
                });
                return [key, null];
              }
            }),
          );
          configurations[String(appId)] = Object.fromEntries(entries);
          completed += 1;
          console.log(`Schema: ${completed}/${apps.length} App(s)`);
        }),
      );
    }

    const deployment = await collectDeployment(
      mcp.callTool,
      apps.map(({ appId }) => String(appId)),
      unknowns,
    );
    const status = unknowns.length ? "partial" : "complete";
    const snapshot = {
      schema_version: "0.2",
      run_id: runId,
      collected_at: new Date().toISOString(),
      target: {
        environment_id: environment.id,
        alias: environment.label,
        base_url: environment.baseUrl,
        access_mode: environment.accessMode,
        app_scope: apps.map(({ appId }) => String(appId)),
      },
      sources: [
        {
          method: MCP_PACKAGE,
          status,
          tools: [...requiredTools],
          limitations: [
            "No record payloads collected.",
            "Permissions, views, JavaScript/CSS, Webhooks, and plugin configuration are not covered.",
            "Users, organizations, and groups are reserved in the snapshot but not collected in version 0.0.17.",
          ],
        },
      ],
      assets: { apps },
      configurations,
      deployment,
      identity_coverage: {
        status: "not-collected",
        users: null,
        organizations: null,
        groups: null,
        limitations: [
          "User lifecycle, organization hierarchy, group purpose, membership, and administrator concentration are not collected in version 0.0.17.",
        ],
      },
      unknowns,
    };
    await mkdir(outputDir, { recursive: true });
    const snapshotPath = path.join(outputDir, "snapshot.json");
    const runPath = path.join(outputDir, "run.json");
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await writeFile(
      runPath,
      `${JSON.stringify(
        {
          version: "0.0.17",
          runId,
          environmentId: environment.id,
          status,
          appCount: apps.length,
          completedAppCount: completed,
          unknownCount: unknowns.length,
          snapshotPath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`Snapshot: ${snapshotPath}`);
    console.log(`Result: ${status}; App(s): ${apps.length}; unknown(s): ${unknowns.length}`);
  } finally {
    mcp.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`Read-only collection failed: ${error.message}`);
  process.exit(1);
}
