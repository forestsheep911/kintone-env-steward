#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseYaml, stringifyYaml } from "./yaml-lite.mjs";

const args = process.argv.slice(2);

function argument(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const host = "127.0.0.1";
const port = Number(argument("--port", "4317"));
const workspace = path.resolve(argument("--workspace", process.cwd()));
const requestedUiMode = argument("--ui-mode", "auto");
const initialContextArgument = argument("--initial-context", "");
const initialContextPath = initialContextArgument
  ? path.resolve(initialContextArgument)
  : null;
const configDirectory = path.join(workspace, ".kintone-env-steward");
const configPath = path.join(configDirectory, "environments.yaml");
const legacyConfigPath = path.join(configDirectory, "environments.json");
const credentialsPath = path.join(configDirectory, "credentials.local.json");
const launchPath = path.join(configDirectory, "config-ui.json");
const accessRequestPath = path.join(configDirectory, "access-request.local.json");
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.dirname(scriptDirectory);
const assetsDirectory = path.join(skillDirectory, "assets", "config-ui", "dist");
const validatorPath = path.join(scriptDirectory, "validate-environments.mjs");
const csrfToken = randomBytes(32).toString("hex");
const maxBodyBytes = 1024 * 1024;

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("--port must be an integer from 1024 to 65535");
  process.exit(2);
}

if (!["auto", "simple", "advanced"].includes(requestedUiMode)) {
  console.error("--ui-mode must be auto, simple, or advanced");
  process.exit(2);
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": contentTypes[".json"],
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readCredentialStore() {
  try {
    const store = JSON.parse(await readFile(credentialsPath, "utf8"));
    if (
      store?.version !== "1.0" ||
      store.credentials === null ||
      typeof store.credentials !== "object" ||
      Array.isArray(store.credentials)
    ) {
      throw new Error("local credential store has an unsupported format");
    }
    return store;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: "1.0", credentials: {} };
    }
    throw error;
  }
}

function credentialStatus(store, environments = []) {
  return Object.fromEntries(
    environments.map((environment) => {
      const saved = store.credentials[environment.id] || {};
      const method = environment.credentialRef?.method;
      const required =
        method === "api-token"
          ? ["apiToken"]
          : method === "client-certificate-password"
            ? ["username", "password", "pfxFilePath", "pfxPassword"]
            : ["username", "password"];
      return [
        environment.id,
        {
          configured: required.every(
            (field) => typeof saved[field] === "string" && saved[field] !== "",
          ),
          method,
          fields: Object.fromEntries(
            required.map((field) => [
              field,
              typeof saved[field] === "string" && saved[field] !== "",
            ]),
          ),
        },
      ];
    }),
  );
}

function validateSecretValue(location, value) {
  if (typeof value !== "string") {
    throw Object.assign(new Error(`${location} must be a string`), { status: 400 });
  }
  if (value.length > 8192 || value.includes("\u0000")) {
    throw Object.assign(new Error(`${location} is not a valid local credential value`), {
      status: 400,
    });
  }
}

async function applyCredentialChanges(config, changes) {
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) {
    throw Object.assign(new Error("credentialChanges must be an object"), { status: 400 });
  }
  const store = await readCredentialStore();
  const environments = new Map(config.environments.map((environment) => [environment.id, environment]));
  const allowedFields = new Set([
    "username",
    "password",
    "apiToken",
    "pfxFilePath",
    "pfxPassword",
  ]);

  for (const [environmentId, change] of Object.entries(changes)) {
    if (!environments.has(environmentId)) {
      throw Object.assign(new Error(`credential change references unknown environment ${environmentId}`), {
        status: 400,
      });
    }
    if (change === null || typeof change !== "object" || Array.isArray(change)) {
      throw Object.assign(new Error(`credentialChanges.${environmentId} must be an object`), {
        status: 400,
      });
    }
    if (change.clear === true) {
      delete store.credentials[environmentId];
      continue;
    }
    const next = { ...(store.credentials[environmentId] || {}) };
    for (const [field, value] of Object.entries(change)) {
      if (field === "clear") continue;
      if (!allowedFields.has(field)) {
        throw Object.assign(new Error(`credential field ${field} is not supported`), {
          status: 400,
        });
      }
      validateSecretValue(`credentialChanges.${environmentId}.${field}`, value);
      if (value !== "") next[field] = value;
    }
    store.credentials[environmentId] = next;
  }

  const validEnvironmentIds = new Set(config.environments.map((environment) => environment.id));
  for (const environmentId of Object.keys(store.credentials)) {
    if (!validEnvironmentIds.has(environmentId)) delete store.credentials[environmentId];
  }
  await mkdir(configDirectory, { recursive: true });
  const temporaryPath = path.join(configDirectory, `credentials.${process.pid}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, credentialsPath);
  return credentialStatus(store, config.environments);
}

function baseStarterConfig() {
  return {
    schemaVersion: "1.0",
    activeEnvironmentId: "customer-source",
    engagement: {
      id: "kintone-governance",
      customerAlias: "new-customer",
      artifactRoot: "outputs/kintone-env-steward/kintone-governance",
    },
    workflow: {
      mode: "analysis-only",
      sourceEnvironmentId: "customer-source",
      experimentEnvironmentIds: [],
      targetEnvironmentId: null,
    },
    environments: [
      {
        id: "customer-source",
        label: "客户环境（只读分析）",
        kind: "customer-source",
        accessMode: "read-only",
        baseUrl: "https://example.cybozu.com",
        requiredRole: "system-administrator",
        credentialRef: {
          method: "password",
          usernameEnv: "KINTONE_SOURCE_USERNAME",
          passwordEnv: "KINTONE_SOURCE_PASSWORD",
        },
        appScope: ["*"],
      },
    ],
  };
}

function safeEnvironmentFromContext(environment, index) {
  const kind = ["customer-source", "experiment", "customer-target"].includes(environment?.kind)
    ? environment.kind
    : index === 0
      ? "customer-source"
      : "experiment";
  const id =
    typeof environment?.id === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(environment.id)
      ? environment.id
      : kind === "customer-source"
        ? "customer-source"
        : `lab-${index}`;
  const base = baseStarterConfig().environments[0];
  const credentialMethod = [
    "password",
    "api-token",
    "client-certificate-password",
  ].includes(environment?.credentialMethod)
    ? environment.credentialMethod
    : "password";
  const credentialPrefix = id.replaceAll("-", "_").toUpperCase();
  const credentialRef =
    credentialMethod === "api-token"
      ? { method: credentialMethod, apiTokenEnv: `${credentialPrefix}_API_TOKEN` }
      : {
          method: credentialMethod,
          usernameEnv: `${credentialPrefix}_ADMIN_USERNAME`,
          passwordEnv: `${credentialPrefix}_ADMIN_PASSWORD`,
          ...(credentialMethod === "client-certificate-password"
            ? {
                pfxFilePathEnv: `${credentialPrefix}_PFX_PATH`,
                pfxPasswordEnv: `${credentialPrefix}_PFX_PASSWORD`,
              }
            : {}),
        };
  const next = {
    ...base,
    id,
    label:
      typeof environment?.label === "string"
        ? environment.label
        : kind === "customer-source"
          ? "客户环境（只读分析）"
          : `实验环境 ${index}`,
    kind,
    accessMode:
      kind !== "customer-source" && environment?.accessMode === "read-write"
        ? "read-write"
        : "read-only",
    baseUrl:
      typeof environment?.baseUrl === "string"
        ? environment.baseUrl
        : base.baseUrl,
    requiredRole:
      typeof environment?.requiredRole === "string"
        ? environment.requiredRole
        : credentialMethod === "api-token"
          ? "app-administrator"
          : "system-administrator",
    appScope:
      Array.isArray(environment?.appScope) &&
      environment.appScope.every((item) => typeof item === "string")
        ? environment.appScope
        : base.appScope,
    credentialRef,
  };
  return next;
}

async function readInitialContext() {
  if (!initialContextPath) return null;
  const text = await readFile(initialContextPath, "utf8");
  const parsed = initialContextPath.toLowerCase().endsWith(".json")
    ? JSON.parse(text)
    : parseYaml(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--initial-context must contain a JSON or YAML object");
  }
  return parsed;
}

const initialContext = await readInitialContext();

function starterConfig() {
  const config = baseStarterConfig();
  if (!initialContext) return config;
  const engagement = initialContext.engagement || initialContext;
  for (const key of ["id", "customerAlias", "artifactRoot"]) {
    if (typeof engagement[key] === "string" && engagement[key] !== "") {
      config.engagement[key] = engagement[key];
    }
  }
  if (Array.isArray(initialContext.environments) && initialContext.environments.length > 0) {
    config.environments = initialContext.environments.map(safeEnvironmentFromContext);
  } else if (
    typeof initialContext.baseUrl === "string" ||
    Array.isArray(initialContext.appScope)
  ) {
    config.environments = [
      safeEnvironmentFromContext(
        {
          kind: "customer-source",
          baseUrl: initialContext.baseUrl,
          appScope: initialContext.appScope,
          label: initialContext.environmentAlias,
        },
        0,
      ),
    ];
  }
  const source = config.environments.find((environment) => environment.kind === "customer-source");
  const experiments = config.environments.filter((environment) => environment.kind === "experiment");
  const target = config.environments.find((environment) => environment.kind === "customer-target");
  const cycle = experiments.length > 0 || Boolean(target);
  config.activeEnvironmentId = source?.id || config.environments[0]?.id || "";
  config.workflow = {
    mode: cycle ? "experiment-cycle" : "analysis-only",
    sourceEnvironmentId: source?.id || "",
    experimentEnvironmentIds: experiments.map((environment) => environment.id),
    targetEnvironmentId: cycle ? target?.id || "" : null,
  };
  return config;
}

function resolveUiMode(config, useInitialContext = true) {
  const contextMode =
    useInitialContext &&
    initialContext &&
    ["simple", "advanced"].includes(initialContext.uiMode)
      ? initialContext.uiMode
      : null;
  const explicitMode = requestedUiMode === "auto" ? contextMode : requestedUiMode;
  if (explicitMode) {
    return {
      uiMode: explicitMode,
      uiModeReason:
        requestedUiMode === "auto"
          ? "根据聊天中确认的配置方式显示"
          : "由启动参数指定界面模式",
    };
  }
  const reasons = [];
  if (config.environments.length > 2) reasons.push("环境较多");
  if (config.environments.some((environment) => environment.kind === "customer-target")) {
    reasons.push("包含客户实施环境");
  }
  if (
    config.environments.some(
      (environment) => environment.credentialRef?.method === "client-certificate-password",
    )
  ) {
    reasons.push("包含客户端证书");
  }
  return reasons.length
    ? { uiMode: "advanced", uiModeReason: `自动使用完整模式：${reasons.join("、")}` }
    : { uiMode: "simple", uiModeReason: "当前配置较简单，已隐藏不常用选项" };
}

async function readConfig() {
  try {
    return { config: parseYaml(await readFile(configPath, "utf8")), exists: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    const config = JSON.parse(await readFile(legacyConfigPath, "utf8"));
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configPath, stringifyYaml(config), { encoding: "utf8", mode: 0o600 });
    return { config, exists: true, migratedFrom: legacyConfigPath };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { config: starterConfig(), exists: false };
    }
    throw error;
  }
}

function runValidator(config) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [validatorPath, "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      const warnings = stderr
        .split(/\r?\n/)
        .filter((line) => line.startsWith("WARNING "))
        .map((line) => line.slice(8));
      const errors = stderr
        .split(/\r?\n/)
        .filter((line) => line.startsWith("ERROR "))
        .map((line) => line.slice(6));
      resolve({ valid: code === 0, warnings, errors, summary: stdout.trim() });
    });
    child.stdin.end(JSON.stringify(config));
  });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw Object.assign(new Error("Request body is too large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function acceptsMutation(request) {
  const expectedOrigin = `http://${host}:${port}`;
  return (
    request.headers.origin === expectedOrigin &&
    request.headers["x-steward-csrf"] === csrfToken &&
    request.headers["content-type"]?.startsWith("application/json")
  );
}

async function saveConfig(config) {
  await mkdir(configDirectory, { recursive: true });
  try {
    await stat(configPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(configPath, path.join(configDirectory, `environments.${stamp}.backup.yaml`));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(configDirectory, `environments.${process.pid}.tmp`);
  await writeFile(temporaryPath, stringifyYaml(config), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, configPath);
}

function simplifyConfig(config) {
  const simplified = structuredClone(config);
  simplified.environments = simplified.environments.map((environment) => {
    const next = { ...environment };
    delete next.allowedOperations;
    delete next.approvals;
    delete next.dataHandling;
    return next;
  });
  return simplified;
}

async function readAccessRequest() {
  try {
    const request = JSON.parse(await readFile(accessRequestPath, "utf8"));
    if (
      typeof request.id !== "string" ||
      typeof request.environmentId !== "string" ||
      !["read-only", "read-write"].includes(request.requestedAccessMode) ||
      typeof request.reason !== "string"
    ) {
      throw new Error("access request has an unsupported format");
    }
    const { config } = await readConfig();
    const environment = config.environments.find(
      (item) => item.id === request.environmentId,
    );
    if (!environment) {
      throw new Error(`access request references unknown environment ${request.environmentId}`);
    }
    return {
      ...request,
      environmentLabel: environment.label,
      currentAccessMode: environment.accessMode,
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveAccessRequest(requestId, decision) {
  const request = await readAccessRequest();
  if (!request || request.id !== requestId) {
    throw Object.assign(new Error("access request is no longer current"), { status: 409 });
  }
  if (!["approve", "deny"].includes(decision)) {
    throw Object.assign(new Error("decision must be approve or deny"), { status: 400 });
  }
  if (decision === "deny") {
    await unlink(accessRequestPath);
    return { resolved: true, approved: false };
  }
  const { config } = await readConfig();
  const next = simplifyConfig(config);
  const environment = next.environments.find(
    (item) => item.id === request.environmentId,
  );
  environment.accessMode = request.requestedAccessMode;
  const validation = await runValidator(next);
  if (!validation.valid) {
    throw Object.assign(new Error("updated configuration is invalid"), {
      status: 422,
      validation,
    });
  }
  await saveConfig(next);
  await unlink(accessRequestPath);
  return {
    resolved: true,
    approved: true,
    environmentId: environment.id,
    accessMode: environment.accessMode,
    configPath,
    ...validation,
  };
}

async function serveAsset(response, assetName) {
  const relativeName = assetName || "index.html";
  const candidatePath = path.resolve(assetsDirectory, relativeName);
  const assetsRoot = `${path.resolve(assetsDirectory)}${path.sep}`;
  if (
    candidatePath !== path.resolve(assetsDirectory, "index.html") &&
    !candidatePath.startsWith(assetsRoot)
  ) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  try {
    let body = await readFile(candidatePath);
    if (relativeName === "index.html") {
      body = Buffer.from(
        body.toString("utf8").replace("__STEWARD_CSRF_TOKEN__", csrfToken),
        "utf8",
      );
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(assetName)],
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    response.end(body);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { status: "ok", version: "0.0.17" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/meta") {
      const { config, exists } = await readConfig();
      sendJson(response, 200, {
        version: "0.0.17",
        workspace,
        configPath,
        credentialsPath,
        accessRequestPath,
        ...resolveUiMode(config, !exists),
        initialContextApplied: Boolean(initialContext && !exists),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      sendJson(response, 200, await readConfig());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/credentials/status") {
      const [{ config }, store] = await Promise.all([readConfig(), readCredentialStore()]);
      sendJson(response, 200, {
        credentialsPath,
        environments: credentialStatus(store, config.environments),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/access-request") {
      sendJson(response, 200, { request: await readAccessRequest() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/validate") {
      if (!acceptsMutation(request)) {
        sendJson(response, 403, { error: "Local request verification failed" });
        return;
      }
      sendJson(response, 200, await runValidator(await readBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/config") {
      if (!acceptsMutation(request)) {
        sendJson(response, 403, { error: "Local request verification failed" });
        return;
      }
      const payload = await readBody(request);
      const config = simplifyConfig(payload.config || payload);
      const credentialChanges = payload.credentialChanges || {};
      const validation = await runValidator(config);
      if (!validation.valid) {
        sendJson(response, 422, validation);
        return;
      }
      await saveConfig(config);
      const credentials = await applyCredentialChanges(config, credentialChanges);
      sendJson(response, 200, {
        saved: true,
        configPath,
        credentialsPath,
        credentials,
        ...validation,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/access-request/resolve") {
      if (!acceptsMutation(request)) {
        sendJson(response, 403, { error: "Local request verification failed" });
        return;
      }
      const payload = await readBody(request);
      sendJson(
        response,
        200,
        await resolveAccessRequest(payload.requestId, payload.decision),
      );
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const assetName =
      url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.replace(/^\//, ""));
    await serveAsset(response, assetName);
  } catch (error) {
    sendJson(response, error.status || 500, { error: error.message });
  }
});

server.listen(port, host, async () => {
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    launchPath,
    `${JSON.stringify(
      {
        version: "0.0.17",
        pid: process.pid,
        url: `http://${host}:${port}`,
        workspace,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`kintone-env-Steward v0.0.17 configuration console`);
  console.log(`URL: http://${host}:${port}`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Config: ${configPath}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
