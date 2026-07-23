#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stringifyYaml } from "./yaml-lite.mjs";
import { parseAppScopeExpression } from "./app-scope.mjs";

const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const answersPath = option("--answers");
const outputPath = path.resolve(
  option("--output") ??
    path.join(process.cwd(), ".kintone-env-steward", "environments.yaml"),
);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");

function slug(value, fallback) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || fallback;
}

function envPrefix(value, fallback) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function parseApps(value) {
  return parseAppScopeExpression(value ?? "*");
}

function parseUrl(value, field) {
  const parsed = new URL(String(value ?? "").trim());
  if (parsed.protocol !== "https:") {
    throw new Error(`${field} 必须使用 https://`);
  }
  return parsed.origin;
}

function credentialRef(prefix) {
  return {
    method: "password",
    usernameEnv: `${prefix}_USERNAME`,
    passwordEnv: `${prefix}_PASSWORD`,
  };
}

function buildContract(answers) {
  const mode = answers.mode === "experiment-cycle"
    ? "experiment-cycle"
    : "analysis-only";
  const customerAlias = slug(answers.customerAlias, "customer");
  const engagementId = slug(
    answers.engagementId,
    `${customerAlias}-governance`,
  );
  const sourceUrl = parseUrl(answers.source?.baseUrl, "客户环境地址");
  const sourcePrefix = envPrefix(
    answers.source?.credentialPrefix,
    "CUSTOMER_SOURCE_ADMIN",
  );
  const source = {
    id: "customer-source",
    label: answers.source?.label || "Customer source environment",
    kind: "customer-source",
    accessMode: "read-only",
    baseUrl: sourceUrl,
    requiredRole: "system-administrator",
    credentialRef: credentialRef(sourcePrefix),
    appScope: parseApps(answers.source?.appScope),
  };

  const environments = [source];
  const experimentIds = [];
  let targetEnvironmentId = null;

  if (mode === "experiment-cycle") {
    const labs = Array.isArray(answers.labs) ? answers.labs : [];
    if (labs.length === 0) {
      throw new Error("完整实验流程至少需要一个实验环境");
    }
    for (const [index, labAnswer] of labs.entries()) {
      const id = slug(labAnswer.id, `lab-${index + 1}`);
      const prefix = envPrefix(
        labAnswer.credentialPrefix,
        `LAB${index + 1}_ADMIN`,
      );
      experimentIds.push(id);
      environments.push({
        id,
        label: labAnswer.label || `Experiment environment ${index + 1}`,
        kind: "experiment",
        accessMode: "read-write",
        baseUrl: parseUrl(labAnswer.baseUrl, `实验环境 ${index + 1} 地址`),
        requiredRole: "system-administrator",
        credentialRef: credentialRef(prefix),
        appScope: parseApps(labAnswer.appScope ?? "*"),
      });
    }

    const sameAsSource = answers.target?.sameAsSource !== false;
    const targetPrefix = envPrefix(
      answers.target?.credentialPrefix,
      sameAsSource ? sourcePrefix : "CUSTOMER_TARGET_ADMIN",
    );
    targetEnvironmentId = "customer-target";
    environments.push({
      id: targetEnvironmentId,
      label: answers.target?.label || "Customer implementation target",
      kind: "customer-target",
      accessMode: "read-write",
      baseUrl: sameAsSource
        ? sourceUrl
        : parseUrl(answers.target?.baseUrl, "最终实施环境地址"),
      requiredRole: "system-administrator",
      credentialRef: credentialRef(targetPrefix),
      appScope: parseApps(
        answers.target?.appScope ?? answers.source?.appScope,
      ),
    });
  }

  return {
    schemaVersion: "1.0",
    activeEnvironmentId: "customer-source",
    engagement: {
      id: engagementId,
      customerAlias,
      artifactRoot: `outputs/kintone-env-steward/${engagementId}`,
    },
    workflow: {
      mode,
      sourceEnvironmentId: "customer-source",
      experimentEnvironmentIds: experimentIds,
      targetEnvironmentId,
    },
    environments,
  };
}

async function collectInteractiveAnswers() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  async function ask(question, fallback) {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback;
  }

  async function yesNo(question, fallback = true) {
    const marker = fallback ? "Y/n" : "y/N";
    const answer = (await rl.question(`${question} [${marker}]: `))
      .trim()
      .toLowerCase();
    if (!answer) return fallback;
    return ["y", "yes", "是", "好"].includes(answer);
  }

  console.log("\nkintone-env-Steward 首次使用向导");
  console.log("不会询问或保存真实密码、Token。\n");

  const fullCycle = await yesNo(
    "是否要配置“客户分析 → 多环境实验 → 客户实施”的完整流程",
    false,
  );
  const customerAlias = await ask("客户代号（不要使用真实公司全名）", "customer-a");
  const sourceBaseUrl = await ask(
    "需要分析的客户 kintone 地址",
    "https://example.cybozu.com",
  );
  const appScope = await ask(
    '分析哪些 App？支持 1,3-5,7-12；全部输入 "*"',
    "*",
  );
  const sourcePrefix = await ask(
    "客户系统管理员凭据的环境变量前缀",
    "CUSTOMER_SOURCE_ADMIN",
  );
  const answers = {
    mode: fullCycle ? "experiment-cycle" : "analysis-only",
    customerAlias,
    source: {
      baseUrl: sourceBaseUrl,
      appScope,
      credentialPrefix: sourcePrefix,
    },
  };

  if (fullCycle) {
    const labCount = Number(await ask("实验环境数量", "3"));
    if (!Number.isInteger(labCount) || labCount < 1 || labCount > 10) {
      rl.close();
      throw new Error("实验环境数量必须是 1 到 10 的整数");
    }
    answers.labs = [];
    for (let index = 0; index < labCount; index += 1) {
      answers.labs.push({
        id: `lab-${index + 1}`,
        baseUrl: await ask(
          `实验环境 ${index + 1} 的 kintone 地址`,
          `https://lab-${index + 1}.example.cybozu.com`,
        ),
        appScope: "*",
        credentialPrefix: await ask(
          `实验环境 ${index + 1} 的管理员凭据环境变量前缀`,
          `LAB${index + 1}_ADMIN`,
        ),
      });
    }
    const sameAsSource = await yesNo(
      "最终实施是否回到同一个客户 kintone 环境",
      true,
    );
    answers.target = {
      sameAsSource,
      baseUrl: sameAsSource
        ? undefined
        : await ask("最终实施环境地址", sourceBaseUrl),
      appScope,
      credentialPrefix: sameAsSource
        ? sourcePrefix
        : await ask(
            "最终实施环境管理员凭据环境变量前缀",
            "CUSTOMER_TARGET_ADMIN",
          ),
    };
  }

  rl.close();
  return answers;
}

let answers;
try {
  answers = answersPath
    ? JSON.parse(await readFile(path.resolve(answersPath), "utf8"))
    : await collectInteractiveAnswers();
} catch (error) {
  console.error(`无法读取向导答案: ${error.message}`);
  process.exit(2);
}

let contract;
try {
  contract = buildContract(answers);
} catch (error) {
  console.error(`无法生成配置: ${error.message}`);
  process.exit(1);
}

if (dryRun) {
  process.stdout.write(stringifyYaml(contract));
  process.exit(0);
}

try {
  if (!force) {
    try {
      await access(outputPath);
      console.error(`配置已存在，未覆盖: ${outputPath}`);
      console.error("确认后使用 --force 覆盖，或指定另一个 --output。");
      process.exit(1);
    } catch {
      // The file does not exist and can be created.
    }
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, stringifyYaml(contract), "utf8");

  const credentialNames = [
    ...new Set(
      contract.environments.flatMap((environment) =>
        Object.entries(environment.credentialRef)
          .filter(([key]) => key.endsWith("Env"))
          .map(([, value]) => value),
      ),
    ),
  ];
  const credentialExamplePath = path.join(
    path.dirname(outputPath),
    "credentials.example.env",
  );
  await writeFile(
    credentialExamplePath,
    [
      "# Active official MCP connection",
      `KINTONE_BASE_URL=${contract.environments[0].baseUrl}`,
      "KINTONE_USERNAME=",
      "KINTONE_PASSWORD=",
      "",
      "# Environment-specific references for Steward and future profile switching",
      ...credentialNames.map((name) => `${name}=`),
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(`已生成环境配置: ${outputPath}`);
  console.log(`已生成空白凭据清单: ${credentialExamplePath}`);
  console.log("请在本机环境变量中设置凭据值，不要把值写回配置或发送到对话。");
} catch (error) {
  console.error(`无法写入配置: ${error.message}`);
  process.exit(1);
}
