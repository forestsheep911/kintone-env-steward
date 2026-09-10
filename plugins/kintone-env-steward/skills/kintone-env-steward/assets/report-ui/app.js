const root = document.querySelector("#app");

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const formatDate = (value) => {
  if (!value) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
};

const severityName = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
  info: "信息",
};

function appDetail(app) {
  const relationships = app.relationships.length
    ? app.relationships
        .map(
          ({ kind, label, relatedApp }) =>
            `<li>${kind === "lookup" ? "Lookup" : "关联记录"}：${escapeHtml(label)} → App ${escapeHtml(relatedApp)}</li>`,
        )
        .join("")
    : "<li>未发现显式 Lookup 或关联记录</li>";
  const process = app.process.enabled
    ? `<li>流程：${app.process.states.map(escapeHtml).join(" → ")}</li>`
    : "<li>流程管理未启用</li>";
  const flags = [
    app.lifecycleCandidate ? "<li>名称带有实验/测试/旧版信号</li>" : "",
    app.secretFields.length
      ? `<li>敏感字段候选：${app.secretFields.map(({ label }) => escapeHtml(label)).join("、")}</li>`
      : "",
    app.settings.bulkDeletion ? "<li>允许批量删除</li>" : "",
  ]
    .filter(Boolean)
    .join("");

  return `
    <div>
      <p class="detail-title">字段预览</p>
      <div class="field-tags">
        ${
          app.fieldPreview.length
            ? app.fieldPreview
                .map(
                  ({ label, type }) =>
                    `<span class="field-tag">${escapeHtml(label)} <span>${escapeHtml(type)}</span></span>`,
                )
                .join("")
            : '<span class="field-tag">无自定义字段</span>'
        }
      </div>
    </div>
    <div>
      <p class="detail-title">结构信号</p>
      <ul class="detail-list">
        <li>App Code：${escapeHtml(app.code || "未设置")}</li>
        <li>Space：${escapeHtml(app.spaceId || "不属于 Space")}</li>
        <li>标题字段：${escapeHtml(app.settings.titleField || "自动")}</li>
        <li>子表 ${app.subtableCount} 个；附件字段 ${app.attachmentCount} 个</li>
        ${app.audit.views !== null ? `<li>后台审计：视图 ${app.audit.views}、图表 ${app.audit.graphs}、App 权限规则 ${app.audit.appPermissionRules}、记录权限规则 ${app.audit.recordPermissionRules}、字段权限规则 ${app.audit.fieldPermissionRules}</li>` : "<li>后台设置 REST 审计未启用</li>"}
        ${app.audit.views !== null ? `<li>自定义文件 ${app.audit.customizationFileCount} 个；插件 ${app.audit.pluginCount} 个；管理员备注：${app.audit.adminNotePresent ? "有" : "无"}</li>` : ""}
        ${app.audit.views !== null ? `<li>通知规则 ${app.audit.notificationRuleCount} 条；Action ${app.audit.actionCount} 个</li>` : ""}
        ${process}
        ${relationships}
        ${flags}
      </ul>
    </div>`;
}

function render(report) {
  const categories = ["全部", ...report.categories.map(({ name }) => name)];
  root.innerHTML = `
    <header class="site-header">
      <div class="header-inner">
        <div class="brand">
          <div class="brand-mark">ks</div>
          <div>
            <div class="brand-name">kintone-env-Steward</div>
            <div class="brand-version">Local governance report · v0.0.17</div>
          </div>
        </div>
        <nav class="header-nav" aria-label="报告章节">
          <a href="#overview">概览</a>
          <a href="#findings">发现</a>
          <a href="#systems">业务系统候选</a>
          <a href="#map">功能地图</a>
          <a href="#apps">App 清单</a>
          <a href="#coverage">覆盖范围</a>
        </nav>
      </div>
    </header>
    <main class="page">
      <section class="hero" id="overview">
        <div>
          <p class="eyebrow">Environment governance report</p>
          <h1>${escapeHtml(report.source.alias)} 环境<br />App 结构体检</h1>
          <p class="hero-copy">
            基于只读 schema 证据整理 App 的结构、功能域、关系与治理信号。
            功能判断来自名称和配置推断，不读取业务记录。
          </p>
        </div>
        <aside class="scope-card">
          <div class="scope-label">分析环境</div>
          <div class="scope-value">${escapeHtml(report.source.baseUrl)}</div>
          <div class="scope-badges">
            <span class="badge teal">${escapeHtml(report.source.accessMode)}</span>
            <span class="badge success">${report.metrics.successfulDeployments}/${report.metrics.appCount} 已部署</span>
            <span class="badge">采集于 ${escapeHtml(formatDate(report.source.collectedAt))}</span>
          </div>
        </aside>
      </section>

      <section class="metrics" aria-label="关键指标">
        ${[
          [report.metrics.appCount, "可见 App"],
          [report.metrics.totalFields, "字段总数"],
          [report.metrics.spaceCount, "涉及 Space"],
          [report.metrics.processCount, "启用流程"],
          [report.metrics.relationshipCount, "显式 App 关系"],
          [report.metrics.businessBlockCandidateCount, "业务块候选"],
          [report.metrics.confirmedBusinessSystemCount, "已确认业务系统"],
          [report.findings.length, "治理发现"],
        ]
          .map(
            ([value, label]) =>
              `<div class="metric"><div class="metric-value">${value}</div><div class="metric-label">${label}</div></div>`,
          )
          .join("")}
      </section>

      <section class="section" id="findings">
        <div class="section-head">
          <div><p class="section-kicker">PRIORITIES</p><h2>先处理什么</h2></div>
          <p class="section-note">观察事实与风险判断分开呈现。点击相关 App ID，可在下方清单继续查看结构。</p>
        </div>
        <div class="findings">
          ${report.findings
            .map(
              (finding) => `
                <article class="finding" data-severity="${escapeHtml(finding.severity)}">
                  <div class="finding-rail"></div>
                  <div class="finding-id">${escapeHtml(finding.id)}<br /><span class="badge ${escapeHtml(finding.severity)}">${escapeHtml(severityName[finding.severity] || finding.severity)}</span></div>
                  <div>
                    <h3>${escapeHtml(finding.title)}</h3>
                    <p>${escapeHtml(finding.observation)}</p>
                    <p>${escapeHtml(finding.assessment)}</p>
                  </div>
                  <div class="finding-apps">${finding.appIds.slice(0, 8).map((id) => `#${escapeHtml(id)}`).join(" ")}${finding.appIds.length > 8 ? ` 等 ${finding.appIds.length} 个` : ""}</div>
                </article>`,
            )
            .join("")}
        </div>
      </section>

      <section class="section" id="systems">
        <div class="section-head">
          <div><p class="section-kicker">SYSTEM CANDIDATES</p><h2>业务系统候选</h2></div>
          <p class="section-note">仅显式 App 关系可形成高置信系统群；同一 Space 仅作为低置信讨论线索，不代表实际业务系统。</p>
        </div>
        <div class="category-grid">
          ${report.systemClusters.candidates.length ? report.systemClusters.candidates.map((candidate) => `
            <article class="category-card">
              <div class="category-count">${candidate.apps.length}</div>
              <h3>${escapeHtml(candidate.name || (candidate.kind === "connected-system" ? "显式关联群" : "Space 候选群"))} <span class="badge ${candidate.confidence === "high" ? "success" : "low"}">${candidate.confidence === "high" ? "高置信" : "低置信"}</span> <span class="badge">${candidate.status === "confirmed" ? "已确认" : candidate.status === "excluded" ? "已排除" : "待确认"}</span></h3>
              <p class="section-note">${escapeHtml(candidate.evidence.join("；"))}</p>
              <div class="category-apps">${candidate.apps.map(({ id, name }) => `<span class="app-chip">#${escapeHtml(id)} ${escapeHtml(name)}</span>`).join("")}</div>
            </article>`).join("") : '<article class="coverage-card"><p>未发现由 schema 关系支持的多 App 系统候选。</p></article>'}
        </div>
        <p class="section-note">未归入候选群的单体 App：${report.systemClusters.standalone_app_ids.length} 个。${escapeHtml(report.systemClusters.basis)}</p>
      </section>

      <section class="section" id="map">
        <div class="section-head">
          <div><p class="section-kicker">FUNCTION MAP</p><h2>功能分布</h2></div>
          <p class="section-note">按 App 名称和字段语义自动归类，适合作为讨论入口，不作为最终业务定义。</p>
        </div>
        <div class="category-grid">
          ${report.categories
            .map(
              ({ name, apps }) => `
                <article class="category-card">
                  <div class="category-count">${apps.length}</div>
                  <h3>${escapeHtml(name)}</h3>
                  <div class="category-apps">
                    ${apps.slice(0, 10).map(({ id, name: appName }) => `<span class="app-chip">#${escapeHtml(id)} ${escapeHtml(appName)}</span>`).join("")}
                    ${apps.length > 10 ? `<span class="app-chip">另 ${apps.length - 10} 个</span>` : ""}
                  </div>
                </article>`,
            )
            .join("")}
        </div>
      </section>

      <section class="section" id="apps">
        <div class="section-head">
          <div><p class="section-kicker">APP INVENTORY</p><h2>逐 App 查看</h2></div>
          <p class="section-note">搜索名称、ID、Code 或字段；展开后查看流程、关系和敏感结构信号。</p>
        </div>
        <div class="app-toolbar">
          <input id="app-search" class="control" type="search" placeholder="搜索 App、字段或 App Code" aria-label="搜索 App" />
          <select id="category-filter" class="control" aria-label="按功能域筛选">
            ${categories.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}
          </select>
          <select id="sort-apps" class="control" aria-label="排序">
            <option value="id">按 App ID</option>
            <option value="fields">按字段数</option>
            <option value="name">按名称</option>
          </select>
        </div>
        <div id="app-list" class="app-list"></div>
      </section>

      <section class="section" id="coverage">
        <div class="section-head">
          <div><p class="section-kicker">EVIDENCE</p><h2>证据与边界</h2></div>
        </div>
        <div class="coverage">
          <article class="coverage-card">
            <h3>本次已覆盖</h3>
            <ul>
              <li>App 清单、字段、布局与一般设置</li>
              <li>流程管理与显式 App 关系</li>
              <li>部署状态</li>
              <li>采集失败：${report.source.unknownCount} 项</li>
            </ul>
          </article>
          <article class="coverage-card">
            <h3>本次未覆盖</h3>
            <ul>
              ${report.source.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
              <li>身份主体：${escapeHtml(report.source.identityCoverage.status)}（用户、组织、组）</li>
              ${report.source.identityCoverage.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ul>
          </article>
        </div>
      </section>
      <footer class="footer">
        Run ${escapeHtml(report.source.runId)} · 报告生成于 ${escapeHtml(formatDate(report.generatedAt))} · 数据仅保存在本机
      </footer>
    </main>`;

  const search = document.querySelector("#app-search");
  const category = document.querySelector("#category-filter");
  const sort = document.querySelector("#sort-apps");
  const list = document.querySelector("#app-list");

  function drawApps() {
    const query = search.value.trim().toLowerCase();
    let apps = report.apps.filter((app) => {
      const haystack = [
        app.id,
        app.name,
        app.code,
        app.category,
        ...app.fieldPreview.flatMap(({ label, code }) => [label, code]),
      ]
        .join(" ")
        .toLowerCase();
      return (!query || haystack.includes(query)) &&
        (category.value === "全部" || app.category === category.value);
    });
    apps = [...apps].sort((a, b) => {
      if (sort.value === "fields") return b.fieldCount - a.fieldCount;
      if (sort.value === "name") return a.name.localeCompare(b.name, "zh-CN");
      return Number(a.id) - Number(b.id);
    });
    list.innerHTML = apps.length
      ? apps
          .map(
            (app) => `
              <article class="app-row" data-app-id="${escapeHtml(app.id)}">
                <button class="app-summary" type="button" aria-expanded="false">
                  <span class="app-id">App ${escapeHtml(app.id)}</span>
                  <span class="app-name">${escapeHtml(app.name)}</span>
                  <span class="app-category">${escapeHtml(app.category)}</span>
                  <span class="app-number">${app.fieldCount} 字段</span>
                  <span class="app-number">${app.relationships.length} 关系</span>
                  <span class="chevron">⌄</span>
                </button>
                <div class="app-detail">${appDetail(app)}</div>
              </article>`,
          )
          .join("")
      : '<div class="empty">没有符合条件的 App</div>';

    list.querySelectorAll(".app-summary").forEach((button) => {
      button.addEventListener("click", () => {
        const row = button.closest(".app-row");
        const open = row.classList.toggle("open");
        button.setAttribute("aria-expanded", String(open));
      });
    });
  }

  search.addEventListener("input", drawApps);
  category.addEventListener("change", drawApps);
  sort.addEventListener("change", drawApps);
  drawApps();
}

fetch("./report-data.json", { cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then(render)
  .catch((error) => {
    root.innerHTML = `<main class="loading-shell"><div class="loading-mark">!</div><p>无法读取报告：${escapeHtml(error.message)}</p></main>`;
  });
