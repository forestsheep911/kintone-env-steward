#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseYaml } from "./yaml-lite.mjs";

const args = process.argv.slice(2);
const checkEnv = args.includes("--check-env");
const configArg = args.find((arg) => !arg.startsWith("--"));

if (!configArg) {
  console.error(
    "Usage: node validate-environments.mjs <environments.yaml|environments.json> [--check-env]",
  );
  process.exit(2);
}

const errors = [];
const warnings = [];
const envNamePattern = /^[A-Z][A-Z0-9_]+$/;

function addError(location, message) {
  errors.push(`${location}: ${message}`);
}

function addWarning(location, message) {
  warnings.push(`${location}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkEnvRef(location, name) {
  if (typeof name !== "string" || !envNamePattern.test(name)) {
    addError(location, "must be an uppercase environment-variable name");
    return;
  }
  if (checkEnv && !process.env[name]) {
    addError(location, `referenced environment variable ${name} is not set`);
  }
}

function validateCredential(environment, location) {
  const credential = environment.credentialRef;
  if (!isObject(credential)) {
    addError(`${location}.credentialRef`, "must be an object");
    return;
  }

  const allowedKeys = new Set([
    "method",
    "usernameEnv",
    "passwordEnv",
    "apiTokenEnv",
    "pfxFilePathEnv",
    "pfxPasswordEnv",
  ]);
  for (const key of Object.keys(credential)) {
    if (!allowedKeys.has(key)) {
      addError(
        `${location}.credentialRef.${key}`,
        "is not allowed; store only supported environment-variable references",
      );
    }
  }

  if (
    !["password", "api-token", "client-certificate-password"].includes(
      credential.method,
    )
  ) {
    addError(`${location}.credentialRef.method`, "is not supported");
    return;
  }

  if (credential.method === "api-token") {
    checkEnvRef(`${location}.credentialRef.apiTokenEnv`, credential.apiTokenEnv);
    if (environment.requiredRole === "system-administrator") {
      addError(
        `${location}.credentialRef.method`,
        "api-token cannot represent a system-administrator login",
      );
    }
    return;
  }

  checkEnvRef(`${location}.credentialRef.usernameEnv`, credential.usernameEnv);
  checkEnvRef(`${location}.credentialRef.passwordEnv`, credential.passwordEnv);

  if (credential.method === "client-certificate-password") {
    checkEnvRef(
      `${location}.credentialRef.pfxFilePathEnv`,
      credential.pfxFilePathEnv,
    );
    checkEnvRef(
      `${location}.credentialRef.pfxPasswordEnv`,
      credential.pfxPasswordEnv,
    );
  }
}

let config;
const resolvedConfig =
  configArg === "-" ? "<stdin>" : path.resolve(configArg);
try {
  let configText;
  if (configArg === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    configText = Buffer.concat(chunks).toString("utf8");
  } else {
    configText = await readFile(resolvedConfig, "utf8");
  }
  const trimmed = configText.trimStart();
  config =
    trimmed.startsWith("{") || trimmed.startsWith("[")
      ? JSON.parse(configText)
      : parseYaml(configText);
} catch (error) {
  console.error(`Cannot read ${resolvedConfig}: ${error.message}`);
  process.exit(2);
}

if (!isObject(config)) {
  addError("$", "configuration must be a mapping/object");
} else {
  if (config.schemaVersion !== "1.0") {
    addError("$.schemaVersion", 'must equal "1.0"');
  }
  if (!isObject(config.engagement)) {
    addError("$.engagement", "must be an object");
  } else {
    if (
      typeof config.engagement.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{1,63}$/.test(config.engagement.id)
    ) {
      addError("$.engagement.id", "must be a lowercase kebab-case identifier");
    }
    for (const key of ["customerAlias", "artifactRoot"]) {
      if (
        typeof config.engagement[key] !== "string" ||
        config.engagement[key].trim() === ""
      ) {
        addError(`$.engagement.${key}`, "must be a non-empty string");
      }
    }
    if (
      typeof config.engagement.artifactRoot === "string" &&
      (path.isAbsolute(config.engagement.artifactRoot) ||
        config.engagement.artifactRoot.split(/[\\/]+/).includes(".."))
    ) {
      addError(
        "$.engagement.artifactRoot",
        "must stay inside the active workspace",
      );
    }
  }
  if (!isObject(config.workflow)) {
    addError("$.workflow", "must be an object");
  }
  if (!Array.isArray(config.environments) || config.environments.length === 0) {
    addError("$.environments", "must contain at least one environment");
  }
}

const environments = Array.isArray(config?.environments)
  ? config.environments
  : [];
const byId = new Map();
const byUrl = new Map();

for (const [index, environment] of environments.entries()) {
  const location = `$.environments[${index}]`;
  if (!isObject(environment)) {
    addError(location, "must be an object");
    continue;
  }
  if (
    typeof environment.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,63}$/.test(environment.id)
  ) {
    addError(`${location}.id`, "must be a lowercase kebab-case identifier");
  } else if (byId.has(environment.id)) {
    addError(`${location}.id`, `duplicates ${environment.id}`);
  } else {
    byId.set(environment.id, environment);
  }

  if (!["customer-source", "experiment", "customer-target"].includes(environment.kind)) {
    addError(`${location}.kind`, "is not a supported environment kind");
  }
  if (typeof environment.label !== "string" || environment.label.trim() === "") {
    addError(`${location}.label`, "must be a non-empty environment alias");
  }

  let normalizedUrl;
  try {
    const parsed = new URL(environment.baseUrl);
    if (parsed.protocol !== "https:") {
      throw new Error("URL must use HTTPS");
    }
    normalizedUrl = parsed.origin.toLowerCase();
  } catch (error) {
    addError(`${location}.baseUrl`, error.message);
  }
  if (normalizedUrl) {
    if (byUrl.has(normalizedUrl)) {
      const previous = byId.get(byUrl.get(normalizedUrl));
      const isCustomerPhasePair =
        previous &&
        new Set([previous.kind, environment.kind]).size === 2 &&
        [previous.kind, environment.kind].every((kind) =>
          ["customer-source", "customer-target"].includes(kind),
        );
      if (isCustomerPhasePair) {
        addWarning(
          `${location}.baseUrl`,
          `shares a physical customer environment with ${previous.id}; enforce phase boundaries`,
        );
      } else {
        addError(
          `${location}.baseUrl`,
          `duplicates environment ${byUrl.get(normalizedUrl)}`,
        );
      }
    } else {
      byUrl.set(normalizedUrl, environment.id);
    }
  }

  if (
    !["system-administrator", "app-administrator", "read-only"].includes(
      environment.requiredRole,
    )
  ) {
    addError(`${location}.requiredRole`, "is not supported");
  } else if (environment.requiredRole !== "system-administrator") {
    addWarning(
      `${location}.requiredRole`,
      "full environment governance normally requires system-administrator",
    );
  }

  validateCredential(environment, location);

  if (
    !Array.isArray(environment.appScope) ||
    environment.appScope.length === 0 ||
    environment.appScope.some(
      (appId) =>
        typeof appId !== "string" ||
        (appId !== "*" &&
          (!/^[1-9][0-9]*$/.test(appId) ||
            BigInt(appId) > 9223372036854775807n)),
    )
  ) {
    addError(
      `${location}.appScope`,
      'must contain App ID strings or "*"',
    );
  }
  if (
    environment.appScope?.includes("*") &&
    environment.appScope.length !== 1
  ) {
    addError(`${location}.appScope`, '"*" cannot be combined with App IDs');
  }
  if (
    Array.isArray(environment.appScope) &&
    new Set(environment.appScope).size !== environment.appScope.length
  ) {
    addError(`${location}.appScope`, "contains duplicate App IDs");
  }
  if (environment.appScope?.length > 10000) {
    addError(`${location}.appScope`, "may contain at most 10000 App IDs");
  }

  if (!["read-only", "read-write"].includes(environment.accessMode)) {
    addError(`${location}.accessMode`, "must be read-only or read-write");
  }
}

if (config?.activeEnvironmentId && !byId.has(config.activeEnvironmentId)) {
  addError(
    "$.activeEnvironmentId",
    `references unknown environment ${config.activeEnvironmentId}`,
  );
}

if (checkEnv && config?.activeEnvironmentId) {
  const active = byId.get(config.activeEnvironmentId);
  if (active) {
    if (!process.env.KINTONE_BASE_URL) {
      addError(
        "$.activeEnvironmentId",
        "KINTONE_BASE_URL is not set for the active MCP environment",
      );
    } else {
      try {
        const configured = new URL(active.baseUrl).origin.toLowerCase();
        const connected = new URL(process.env.KINTONE_BASE_URL).origin.toLowerCase();
        if (configured !== connected) {
          addError(
            "$.activeEnvironmentId",
            `KINTONE_BASE_URL does not match active environment ${active.id}`,
          );
        }
      } catch {
        addError(
          "$.activeEnvironmentId",
          "KINTONE_BASE_URL is not a valid URL",
        );
      }
    }
  }
}

if (isObject(config?.workflow)) {
  if (!["analysis-only", "experiment-cycle"].includes(config.workflow.mode)) {
    addError("$.workflow.mode", "must be analysis-only or experiment-cycle");
  }
  const source = byId.get(config.workflow.sourceEnvironmentId);
  if (!source) {
    addError("$.workflow.sourceEnvironmentId", "references an unknown environment");
  } else if (source.kind !== "customer-source") {
    addError("$.workflow.sourceEnvironmentId", "must reference customer-source");
  }

  const experimentIds = Array.isArray(config.workflow.experimentEnvironmentIds)
    ? config.workflow.experimentEnvironmentIds
    : [];
  if (
    config.workflow.mode === "experiment-cycle" &&
    experimentIds.length === 0
  ) {
    addError(
      "$.workflow.experimentEnvironmentIds",
      "must contain at least one experiment environment",
    );
  }
  for (const id of experimentIds) {
    const environment = byId.get(id);
    if (!environment) {
      addError(
        "$.workflow.experimentEnvironmentIds",
        `references unknown environment ${id}`,
      );
    } else if (environment.kind !== "experiment") {
      addError(
        "$.workflow.experimentEnvironmentIds",
        `${id} is not an experiment environment`,
      );
    }
  }

  if (config.workflow.mode === "experiment-cycle") {
    const target = byId.get(config.workflow.targetEnvironmentId);
    if (!target) {
      addError(
        "$.workflow.targetEnvironmentId",
        "references an unknown environment",
      );
    } else if (target.kind !== "customer-target") {
      addError(
        "$.workflow.targetEnvironmentId",
        "must reference customer-target",
      );
    }
  } else if (config.workflow.targetEnvironmentId !== null) {
    addError(
      "$.workflow.targetEnvironmentId",
      "must be null in analysis-only mode",
    );
  }
}

for (const warning of warnings) {
  console.warn(`WARNING ${warning}`);
}
for (const error of errors) {
  console.error(`ERROR ${error}`);
}

if (errors.length > 0) {
  console.error(
    `Environment contract is invalid: ${errors.length} error(s), ${warnings.length} warning(s).`,
  );
  process.exit(1);
}

console.log(
  `Environment contract is valid: ${environments.length} environment(s), ${warnings.length} warning(s).`,
);
for (const environment of environments) {
  console.log(
    `- ${environment.id}: ${environment.kind}; role=${environment.requiredRole}; access=${environment.accessMode}`,
  );
}
