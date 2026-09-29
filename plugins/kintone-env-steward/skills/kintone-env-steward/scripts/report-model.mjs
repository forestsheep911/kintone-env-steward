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

function knownSum(values) {
  return values.every((value) => Number.isInteger(value) && value >= 0)
    ? values.reduce((sum, value) => sum + value, 0) : null;
}

const booleanLabel = (value) => value === true ? "是" : value === false ? "否" : "未知";

export function buildReportModel(snapshot, { businessSystemMap = null } = {}) {
  if (businessSystemMap && (!snapshot.target?.environment_id ||
      businessSystemMap.environment_id !== snapshot.target.environment_id)) {
    throw new Error("Business system map environment does not match snapshot environment");
  }
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
      audit: {
        views: configuration.audit?.views?.count ?? null,
        graphs: configuration.audit?.graphs?.count ?? null,
        appPermissionRules: configuration.audit?.app_permissions?.rule_count ?? null,
        recordPermissionRules: configuration.audit?.record_permissions?.rule_count ?? null,
        fieldPermissionRules: configuration.audit?.field_permissions?.rule_count ?? null,
        pluginCount: configuration.audit?.plugins?.count ?? null,
        actionCount: configuration.audit?.actions?.count ?? null,
        notificationRuleCount: knownSum(["general_notifications", "per_record_notifications", "reminder_notifications"].map((key) => configuration.audit?.[key]?.rule_count)),
        customizationFileCount: knownSum(["desktop", "mobile"].flatMap((device) => [configuration.audit?.customization?.[device]?.js_count, configuration.audit?.customization?.[device]?.css_count])),
        adminNotePresent: configuration.audit?.admin_notes?.present ?? null,
        externalCustomizationHosts: [...new Set([...(configuration.audit?.customization?.desktop?.external_hosts ?? []), ...(configuration.audit?.customization?.mobile?.external_hosts ?? [])])],
        everyonePermissions: configuration.audit?.app_permissions?.everyone_permission_rule_counts ?? null,
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
  const uiCoverage = snapshot.admin_ui_coverage ?? null;
  const directory = uiCoverage?.app_directory ?? null;
  const commonSecurity = uiCoverage?.common_admin?.security_audit ?? null;
  const license = uiCoverage?.common_admin?.page_data?.AVAILABLE_SERVICES?.kintone ?? null;
  const systemCustomization = uiCoverage?.system_admin?.customization ?? null;
  const guestSummary = uiCoverage?.system_admin?.guests ?? null;
  const sharedAppSettings = uiCoverage?.system_admin?.shared_app_settings ?? null;
  const monitoring = uiCoverage?.system_admin?.monitoring ?? null;

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
  const everyoneManagement = apps.filter(({ audit }) => audit.everyonePermissions?.appEditable > 0);
  if (everyoneManagement.length) {
    findings.push({ id: "GOV-PERM-002", severity: "high", confidence: "high", title: "Everyone 组被授予 App 管理权限", observation: `${everyoneManagement.length} 个 App 的权限规则允许 Everyone 组进行 App 管理。`, assessment: "全局限制未必覆盖历史 App；应逐个确认业务例外，并优先移除不必要的管理授权。", appIds: everyoneManagement.map(({ id }) => id) });
  }
  const everyoneExport = apps.filter(({ audit }) => audit.everyonePermissions?.recordExportable > 0);
  if (everyoneExport.length) {
    findings.push({ id: "GOV-PERM-003", severity: "high", confidence: "high", title: "Everyone 组被授予记录导出权限", observation: `${everyoneExport.length} 个 App 的权限规则允许 Everyone 组导出记录。`, assessment: "应结合数据分类、实际使用者和导出审计要求确认是否保留；这不是记录内容已被导出的证据。", appIds: everyoneExport.map(({ id }) => id) });
  }
  const deletePolicyAppIds = new Set((businessSystemMap?.systems ?? []).filter(({ status, policy }) => status === "confirmed" && policy?.allow_everyone_record_delete === true).flatMap(({ app_ids }) => app_ids));
  const everyoneDeleteWithoutRecordRules = apps.filter(({ audit, id }) => audit.everyonePermissions?.recordDeletable > 0 && audit.recordPermissionRules === 0 && !deletePolicyAppIds.has(id));
  if (everyoneDeleteWithoutRecordRules.length) {
    findings.push({ id: "GOV-PERM-004", severity: "medium", confidence: "high", title: "Everyone 组可删除记录，且未配置记录级权限规则", observation: `${everyoneDeleteWithoutRecordRules.length} 个 App 允许 Everyone 组删除记录，且记录权限规则数为 0。`, assessment: "这可能是有意的开放协作基线，而非错误；应确认哪些 App 需要保留记录级删除限制、流程约束或审计补偿控制。", appIds: everyoneDeleteWithoutRecordRules.map(({ id }) => id) });
  }
  const unprotectedSecretFields = apps.filter(({ secretFields, audit }) => secretFields.length && audit.fieldPermissionRules === 0);
  if (unprotectedSecretFields.length) {
    findings.push({ id: "GOV-SEC-004", severity: "medium", confidence: "medium", title: "敏感字段候选未见字段级权限规则", observation: `${unprotectedSecretFields.length} 个 App 同时存在令牌/密码等字段名信号，且字段权限规则数为 0。`, assessment: "这不证明字段内容敏感或已暴露；应优先核对字段实际用途、App 权限和是否需要字段级隔离。", appIds: unprotectedSecretFields.map(({ id }) => id) });
  }
  const externalCustomization = apps.filter(({ audit }) => audit.externalCustomizationHosts.length);
  if (externalCustomization.length) {
    findings.push({ id: "GOV-CUST-002", severity: "medium", confidence: "high", title: "存在加载外部域名资源的 App 自定义", observation: `${externalCustomization.length} 个 App 的 JS/CSS 自定义引用外部域名资源。`, assessment: "应维护资源所有者、版本、变更评审和失效/供应链风险处置方式；本审计不下载或检查脚本正文。", appIds: externalCustomization.map(({ id }) => id) });
  }
  const workflowWithoutNotifications = apps.filter(({ process, audit }) => process.enabled && audit.notificationRuleCount === 0);
  if (workflowWithoutNotifications.length) {
    findings.push({ id: "GOV-OPS-002", severity: "low", confidence: "high", title: "流程管理 App 未见通知规则", observation: `${workflowWithoutNotifications.length} 个启用流程管理的 App 的一般、记录条件和提醒通知规则数均为 0。`, assessment: "这不是配置错误：团队可能使用 Space、邮件、插件或人工流程通知。应确认关键状态变更是否有明确的知会与升级机制。", appIds: workflowWithoutNotifications.map(({ id }) => id) });
  }
  const pluginsWithoutGovernanceNote = apps.filter(({ audit, descriptionPresent }) => audit.pluginCount > 0 && audit.adminNotePresent === false && !descriptionPresent);
  if (pluginsWithoutGovernanceNote.length) {
    findings.push({ id: "GOV-CUST-003", severity: "low", confidence: "high", title: "挂载插件的 App 缺少用途或管理说明", observation: `${pluginsWithoutGovernanceNote.length} 个挂载插件的 App 同时没有用途说明和管理员备注。`, assessment: "这不评价插件本身安全性；应补充插件用途、负责人、许可证/来源、变更和停用回退信息。", appIds: pluginsWithoutGovernanceNote.map(({ id }) => id) });
  }
  if (directory?.cleanup_candidate_count) {
    findings.push({
      id: "GOV-LIFE-002",
      severity: "medium",
      confidence: "high",
      title: "存在可确认的未启用 App 清理候选",
      observation: `${directory.cleanup_candidate_count} 个未启用 App 同时没有字段、记录、API Token、入站参照和自定义。`,
      assessment: "这些是候选而非删除指令；应先由业务负责人确认用途和保留要求，再建立可恢复的清理计划。",
      appIds: [],
    });
  }
  if (license?.currentUser != null && license?.maxUser != null && Number(license.maxUser) > 0 && Number(license.currentUser) / Number(license.maxUser) >= 0.8) {
    findings.push({
      id: "GOV-CAP-001",
      severity: "medium",
      confidence: "high",
      title: "kintone 用户许可接近容量阈值",
      observation: `当前使用 ${license.currentUser}/${license.maxUser} 个 kintone 用户许可。`,
      assessment: "应在新增用户或项目上线前核对许可扩容、停用账号和交付计划，避免临近上限时阻塞。",
      appIds: [],
    });
  }
  if (commonSecurity?.audit?.critical_notification_configured === false && commonSecurity.audit.information_notification_configured === false) {
    findings.push({
      id: "GOV-AUDIT-002",
      severity: "medium",
      confidence: "high",
      title: "审计日志未配置通知收件人",
      observation: "严重与一般审计事件的通知收件人均未配置。",
      assessment: "需确认是否由外部 SIEM 或固定运营流程覆盖；若没有，应为关键事件定义接收人和处置责任。",
      appIds: [],
    });
  }
  if (commonSecurity?.login?.totp_enabled === false || commonSecurity?.login?.totp_enforced === false) {
    findings.push({
      id: "GOV-SEC-002",
      severity: "low",
      confidence: "high",
      title: "双因素验证未完全启用或强制",
      observation: `TOTP 已启用：${booleanLabel(commonSecurity.login.totp_enabled)}；已强制：${booleanLabel(commonSecurity.login.totp_enforced)}。`,
      assessment: "这不是单独的合规结论；应结合 SSO、网络限制、管理员账号范围和组织安全基线决定是否强制。",
      appIds: [],
    });
  }
  if (systemCustomization?.active && systemCustomization?.executable) {
    findings.push({
      id: "GOV-CUST-001",
      severity: "medium",
      confidence: "high",
      title: "系统级 JavaScript/CSS 自定义处于可执行状态",
      observation: `系统自定义范围为 ${systemCustomization.scope ?? "未知"}，配置文件数为 ${systemCustomization.script_count ?? "未知"}。`,
      assessment: "系统级自定义会影响广泛使用面；应维护负责人、源码位置、变更评审和回退路径。",
      appIds: [],
    });
  }
  if (guestSummary?.count != null && Number(guestSummary.count) > 0 && guestSummary.two_step_verification_enabled === false) {
    findings.push({
      id: "GOV-SEC-003",
      severity: "medium",
      confidence: "high",
      title: "存在来宾账号但未启用来宾两步验证",
      observation: `当前来宾数为 ${guestSummary.count}，来宾两步验证未启用。`,
      assessment: "应结合来宾的访问范围、外部协作方式和客户安全基线，决定是否启用两步验证或缩小来宾使用范围。",
      appIds: [],
    });
  }
  if (sharedAppSettings?.prohibit_everyone_app_management === false || sharedAppSettings?.prohibit_everyone_record_export === false) {
    const controls = [
      sharedAppSettings.prohibit_everyone_app_management === false ? "应用管理" : null,
      sharedAppSettings.prohibit_everyone_record_export === false ? "记录导出" : null,
    ].filter(Boolean);
    findings.push({
      id: "GOV-PERM-001",
      severity: "medium",
      confidence: "high",
      title: "Everyone 组的高权限全局限制未完全开启",
      observation: `以下限制当前未开启：${controls.join("、")}。`,
      assessment: "这不代表 Everyone 已实际拥有相应权限；应先核对 App 权限基线和业务例外，再决定是否启用全局限制。",
      appIds: [],
    });
  }
  if (monitoring?.full_text_search_oldest_job_delay_seconds != null && Number(monitoring.full_text_search_oldest_job_delay_seconds) > 300) {
    findings.push({
      id: "GOV-OPS-001",
      severity: "medium",
      confidence: "high",
      title: "全文搜索索引处理延迟偏高",
      observation: `最旧全文搜索任务延迟 ${monitoring.full_text_search_oldest_job_delay_seconds} 秒。`,
      assessment: "应结合持续时间、近期批量操作和服务状态确认影响；单次瞬时延迟不应直接判定为故障。",
      appIds: [],
    });
  }
  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const systemClusters = deriveSystemClusters(apps);
  const membership = (ids) => JSON.stringify([...ids].sort());
  const systemCandidates = systemClusters.candidates.map((candidate) => {
    // Membership, not a legacy ordinal ID, identifies a reviewed candidate.
    const reviewed = businessSystemMap?.systems?.find((system) =>
      membership(system.app_ids) === membership(candidate.app_ids));
    return {
      ...candidate,
      ...reviewed,
      id: candidate.id,
      apps: candidate.app_ids.map((id) => ({ id, name: apps.find((app) => app.id === id)?.name ?? "未知 App" }))
    };
  });

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
      collectionSources: snapshot.sources?.map(({ method, status }) => ({ method, status })) ?? [],
      coverageCounts: Object.fromEntries((snapshot.coverage?.resources ?? []).filter(({ key }) => !key.endsWith(":summary") && !key.endsWith(":phase")).reduce((counts, { status }) => counts.set(status, (counts.get(status) ?? 0) + 1), new Map())),
      identityCoverage: snapshot.identity_coverage ?? {
        status: "not-collected",
        users: null,
        organizations: null,
        groups: null,
        limitations: [
          "Users, organizations, and groups were not present in this snapshot.",
        ],
      },
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
      managedAppCount: directory?.app_count ?? null,
      cleanupCandidateCount: directory?.cleanup_candidate_count ?? null,
      businessBlockCandidateCount: systemCandidates.length,
      confirmedBusinessSystemCount: systemCandidates.filter(({ status }) => status === "confirmed").length,
    },
    findings,
    systemClusters: { ...systemClusters, candidates: systemCandidates },
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
import { deriveSystemClusters } from "./derive-system-clusters.mjs";
