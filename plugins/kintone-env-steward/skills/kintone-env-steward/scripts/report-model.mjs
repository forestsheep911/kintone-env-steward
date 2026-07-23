const SYSTEM_FIELD_TYPES = new Set([
  "RECORD_NUMBER",
  "CREATOR",
  "CREATED_TIME",
  "MODIFIER",
  "UPDATED_TIME",
  "STATUS",
  "STATUS_ASSIGNEE",
  "CATEGORY",
]);

const LIFECYCLE_PATTERN =
  /(?:\bdev\b|\btest\b|\bold\b|clone|compare|free research|体验|实验|学习|试用|怎么办|modify event)/i;
const SECRET_PATTERN =
  /(?:token|password|secret|credential|api[_ -]?key|令牌|密码|密钥|凭据)/i;

function flattenFields(properties) {
  const result = [];
  for (const field of Object.values(properties ?? {})) {
    result.push(field);
    if (field.type === "SUBTABLE") {
      result.push(...flattenFields(field.fields));
    }
  }
  return result;
}

function hasMeaningfulDescription(description) {
  return String(description ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:#\d+|[a-z]+);/gi, "")
    .trim().length > 0;
}

function inferCategory(app, fields) {
  const text = `${app.name} ${fields.map(({ label, code }) => `${label} ${code}`).join(" ")}`;
  if (LIFECYCLE_PATTERN.test(app.name)) return "实验与历史版本";
  if (/(?:AI|OCR|智能|翻译|听悟|voice|token 用量)/i.test(text)) return "AI 与内容处理";
  if (/(?:mail|邮件|邮箱|收件|发件|exchange|活动报名)/i.test(text)) return "邮件与活动";
  if (/(?:商谈|商品|订单|报价|客户|企业|company|销售)/i.test(text)) return "业务与销售";
  if (/(?:设备|资产|任务|垃圾|工时|负责人)/i.test(text)) return "运营管理";
  if (/(?:Tab|配置|Config|Log|日志|master)/i.test(text)) return "平台与支撑";
  return "其他";
}

function severityRank(severity) {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[severity] ?? 9;
}

export function buildReportModel(snapshot) {
  const deploymentByApp = new Map(
    (snapshot.deployment?.apps ?? []).map(({ app, status }) => [String(app), status]),
  );

  const apps = snapshot.assets.apps.map((asset) => {
    const configuration = snapshot.configurations?.[asset.appId] ?? {};
    const fields = flattenFields(configuration.fields?.properties);
    const customFields = fields.filter(({ type }) => !SYSTEM_FIELD_TYPES.has(type));
    const typeCounts = Object.fromEntries(
      Object.entries(
        fields.reduce((counts, { type }) => {
          counts[type] = (counts[type] ?? 0) + 1;
          return counts;
        }, {}),
      ).sort(([, a], [, b]) => b - a),
    );
    const lookups = fields
      .filter(({ lookup }) => lookup)
      .map(({ code, label, lookup }) => ({
        kind: "lookup",
        code,
        label,
        relatedApp: String(lookup.relatedApp.app),
      }));
    const references = fields
      .filter(({ referenceTable }) => referenceTable)
      .map(({ code, label, referenceTable }) => ({
        kind: "reference",
        code,
        label,
        relatedApp: String(referenceTable.relatedApp.app),
      }));
    const secretFields = fields
      .filter(({ code, label }) => SECRET_PATTERN.test(`${code} ${label}`))
      .map(({ code, label, type }) => ({ code, label, type }));

    return {
      id: String(asset.appId),
      name: asset.name,
      code: asset.code || "",
      spaceId: asset.spaceId == null ? null : String(asset.spaceId),
      modifiedAt: asset.modifiedAt,
      descriptionPresent: hasMeaningfulDescription(asset.description),
      category: inferCategory(asset, fields),
      fieldCount: fields.length,
      customFieldCount: customFields.length,
      fieldTypes: typeCounts,
      fieldPreview: customFields
        .slice(0, 12)
        .map(({ code, label, type }) => ({ code, label, type })),
      subtableCount: fields.filter(({ type }) => type === "SUBTABLE").length,
      attachmentCount: fields.filter(({ type }) => type === "FILE").length,
      relationships: [...lookups, ...references],
      process: {
        enabled: Boolean(configuration.process?.enable),
        states: configuration.process?.enable
          ? Object.keys(configuration.process.states ?? {})
          : [],
        actions: configuration.process?.enable
          ? (configuration.process.actions ?? []).map(({ name, from, to }) => ({
              name,
              from,
              to,
            }))
          : [],
      },
      settings: {
        bulkDeletion: Boolean(configuration.general?.enableBulkDeletion),
        comments: Boolean(configuration.general?.enableComments),
        duplicateRecord: Boolean(configuration.general?.enableDuplicateRecord),
        inlineEditing: Boolean(configuration.general?.enableInlineRecordEditing),
        titleField: configuration.general?.titleField?.code ?? null,
      },
      deployment: deploymentByApp.get(String(asset.appId)) ?? "UNKNOWN",
      lifecycleCandidate: LIFECYCLE_PATTERN.test(asset.name),
      secretFields,
    };
  });

  const totalFields = apps.reduce((sum, { fieldCount }) => sum + fieldCount, 0);
  const appCodeCount = apps.filter(({ code }) => code).length;
  const describedCount = apps.filter(({ descriptionPresent }) => descriptionPresent).length;
  const processCount = apps.filter(({ process }) => process.enabled).length;
  const relationshipCount = apps.reduce(
    (sum, { relationships }) => sum + relationships.length,
    0,
  );
  const successfulDeployments = apps.filter(
    ({ deployment }) => deployment === "SUCCESS",
  ).length;
  const secretApps = apps.filter(({ secretFields }) => secretFields.length);
  const lifecycleApps = apps.filter(({ lifecycleCandidate }) => lifecycleCandidate);
  const bulkDeletionApps = apps.filter(({ settings }) => settings.bulkDeletion);

  const findings = [];
  if (secretApps.length) {
    findings.push({
      id: "GOV-SEC-001",
      severity: "high",
      confidence: "medium",
      title: "发现可能承载凭据或令牌的字段结构",
      observation: `${secretApps.length} 个 App 的字段名包含令牌、密码、密钥或相近含义。`,
      assessment:
        "字段结构本身不能证明保存了明文秘密，但需要优先核对字段权限、加密方式、调用方与保留周期。",
      appIds: secretApps.map(({ id }) => id),
    });
  }
  if (lifecycleApps.length) {
    findings.push({
      id: "GOV-LIFE-001",
      severity: "medium",
      confidence: "high",
      title: "实验、测试与旧版本 App 的生命周期边界不清",
      observation: `${lifecycleApps.length} 个 App 的名称带有 dev、test、old、clone、体验或实验等标记。`,
      assessment:
        "同一环境混放不同生命周期的 App，可能造成误用、重复维护和数据保留责任不明。",
      appIds: lifecycleApps.map(({ id }) => id),
    });
  }
  if (apps.length && appCodeCount / apps.length < 0.5) {
    findings.push({
      id: "GOV-ID-001",
      severity: "medium",
      confidence: "high",
      title: "稳定 App Code 覆盖率偏低",
      observation: `${apps.length} 个 App 中只有 ${appCodeCount} 个设置了 App Code。`,
      assessment:
        "跨环境迁移和外部集成更可能依赖数字 App ID，复制到实验环境后容易断裂。",
      appIds: apps.filter(({ code }) => !code).map(({ id }) => id),
    });
  }
  if (bulkDeletionApps.length) {
    findings.push({
      id: "GOV-AUDIT-001",
      severity: "medium",
      confidence: "high",
      title: "部分 App 允许批量删除",
      observation: `${bulkDeletionApps.length} 个 App 的一般设置启用了批量删除。`,
      assessment:
        "如果这些 App 承载审计或运行日志，需要结合实际删除权限与保留策略判断风险。",
      appIds: bulkDeletionApps.map(({ id }) => id),
    });
  }
  if (apps.length && describedCount / apps.length < 0.5) {
    findings.push({
      id: "GOV-DOC-001",
      severity: "low",
      confidence: "high",
      title: "App 用途说明覆盖不足",
      observation: `${apps.length} 个 App 中只有 ${describedCount} 个有实质性说明。`,
      assessment:
        "用户难以从门户判断用途、负责人、敏感度、上下游与生命周期状态。",
      appIds: apps.filter(({ descriptionPresent }) => !descriptionPresent).map(({ id }) => id),
    });
  }
  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const categories = Object.entries(
    apps.reduce((groups, app) => {
      (groups[app.category] ??= []).push({ id: app.id, name: app.name });
      return groups;
    }, {}),
  )
    .map(([name, categoryApps]) => ({ name, apps: categoryApps }))
    .sort((a, b) => b.apps.length - a.apps.length);

  return {
    reportVersion: "0.1",
    generatedAt: new Date().toISOString(),
    source: {
      runId: snapshot.run_id,
      collectedAt: snapshot.collected_at,
      environmentId: snapshot.target?.environment_id,
      alias: snapshot.target?.alias,
      baseUrl: snapshot.target?.base_url,
      accessMode: snapshot.target?.access_mode,
      tools: snapshot.sources?.flatMap(({ tools = [] }) => tools) ?? [],
      limitations:
        snapshot.sources?.flatMap(({ limitations = [] }) => limitations) ?? [],
      unknownCount: snapshot.unknowns?.length ?? 0,
    },
    metrics: {
      appCount: apps.length,
      totalFields,
      spaceCount: new Set(apps.map(({ spaceId }) => spaceId).filter(Boolean)).size,
      noSpaceCount: apps.filter(({ spaceId }) => !spaceId).length,
      processCount,
      relationshipCount,
      appCodeCount,
      describedCount,
      successfulDeployments,
    },
    findings,
    categories,
    largestApps: [...apps]
      .sort((a, b) => b.fieldCount - a.fieldCount)
      .slice(0, 10)
      .map(({ id, name, fieldCount, subtableCount, attachmentCount }) => ({
        id,
        name,
        fieldCount,
        subtableCount,
        attachmentCount,
      })),
    apps,
  };
}
