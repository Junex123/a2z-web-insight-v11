// A-to-Z Web Insight - dashboard frontend.
// Vanilla JS on purpose: this MVP has one page and one job, and every
// render below maps directly to fields the server measured - nothing
// here invents or embellishes data.

const form = document.getElementById("scan-form");
const urlInput = document.getElementById("url-input");
const scanButton = document.getElementById("scan-button");
const formError = document.getElementById("form-error");
const loadingSection = document.getElementById("loading");
const reportSection = document.getElementById("report");

const CATEGORY_LABELS = { performance: "Performance", seo: "SEO", security: "Security", accessibility: "Accessibility", ux: "UX", responsiveness: "Responsiveness" };
const NOT_YET_LABELS = {
  content: "Content",
  ux: "UX",
  business: "Business & Conversion",
  "competitor-intelligence": "Competitor Intelligence",
  "search-visibility": "Search Visibility",
};

let currentReport = null;
let activeFilter = "all";

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  formError.hidden = true;

  scanButton.disabled = true;
  reportSection.hidden = true;
  loadingSection.hidden = false;

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Something went wrong while scanning that URL.");
    }

    currentReport = data;
    activeFilter = "all";
    renderReport(data);
  } catch (err) {
    formError.textContent = err.message;
    formError.hidden = false;
  } finally {
    scanButton.disabled = false;
    loadingSection.hidden = true;
  }
});

function tierFor(score) {
  if (score >= 80) return "tier-good";
  if (score >= 50) return "tier-medium";
  return "tier-bad";
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function renderReport(report) {
  document.getElementById("report-url").textContent = report.url;
  const scannedAt = new Date(report.scannedAt);
  document.getElementById("report-meta").textContent =
    `scanned ${scannedAt.toLocaleString()} · HTTP ${report.evidenceLog.fetch.statusCode} · ${Math.round(report.evidenceLog.fetch.bodyBytes / 1024)}KB HTML · report ${report.reportId}`;

  const ring = document.getElementById("overall-ring");
  ring.className = `score-hero__ring ${tierFor(report.scores.overall)}`;
  document.getElementById("overall-score").textContent = report.scores.overall;

  renderCategoryGrid(report);
  renderLaunchDecision(report);
  renderTechnologyStack(report);
  renderComingSoon(report);
  renderCoreWebVitals(report);
  renderMobileDesktopComparison(report);
  renderPrioritizedFixes(report);
  renderPriorityList(report);
  renderFilterTabs(report);
  renderIssueList(report);
  renderAccessibilityCoverage(report);
  renderEvidenceLog(report);

  reportSection.hidden = false;
  reportSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderCategoryGrid(report) {
  const grid = document.getElementById("category-grid");
  grid.innerHTML = "";
  for (const cat of report.categoriesAnalyzed) {
    const score = report.scores[cat];
    const tier = tierFor(score);
    const counts = ["critical", "high", "medium", "low"]
      .map((sev) => ({ sev, n: report.allIssues.filter((i) => i.category === cat && i.severity === sev).length }))
      .filter((c) => c.n > 0);
    const readinessByCategory = new Map((report.launchDecision?.categoryReadiness || []).map((c) => [c.category, c]));
    const readiness = readinessByCategory.get(cat);

    const card = el("div", "category-card");
    card.innerHTML = `
      <div class="category-card__top">
        <span class="category-card__name">${CATEGORY_LABELS[cat]}</span>
        <span class="category-card__score ${tier}">${score}</span>
      </div>
      <div class="category-card__bar"><span class="${tier}" style="width:${score}%"></span></div>
      ${readiness ? `<span class="category-card__readiness readiness--${readiness.status.toLowerCase().replace(/_/g, "-")}">${READINESS_LABELS[readiness.status] || readiness.status}</span>` : ""}
      <div class="category-card__counts">
        ${counts.length ? counts.map((c) => `<span class="severity-chip ${c.sev}">${c.n} ${c.sev}</span>`).join("") : `<span class="severity-chip low" style="background:var(--good-tint); color:var(--good)">no issues found</span>`}
      </div>
    `;
    grid.appendChild(card);
  }
}

const READINESS_LABELS = {
  READY: "Ready",
  READY_WITH_WARNINGS: "Ready, with warnings",
  NOT_READY: "Not ready",
  UNVERIFIED: "Unverified",
};

const LAUNCH_STATUS_LABELS = {
  READY: "Ready",
  READY_WITH_WARNINGS: "Ready, with warnings",
  NOT_READY: "Not ready",
};

function renderLaunchDecision(report) {
  const decision = report.launchDecision;
  const banner = document.getElementById("launch-banner");
  if (!decision) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.className = `panel launch-banner launch-banner--${decision.status.toLowerCase().replace(/_/g, "-")}`;

  document.getElementById("launch-status").textContent = LAUNCH_STATUS_LABELS[decision.status] || decision.status;
  document.getElementById("launch-summary").textContent = decision.summary;

  const blockersEl = document.getElementById("launch-blockers");
  blockersEl.innerHTML = "";
  if (decision.blockers.length) {
    const list = el("ul", "launch-blocker-list");
    for (const b of decision.blockers) {
      const scope = b.affected.length > 1 ? `${b.affected.length} pages checked` : b.affected[0];
      list.innerHTML += `<li><span class="severity-chip critical">blocker</span> <b>${escapeHtml(b.title)}</b> — ${escapeHtml(b.reason)} <span class="launch-blocker-scope">(${escapeHtml(scope)})</span></li>`;
    }
    blockersEl.appendChild(list);
  }

  const whyEl = document.getElementById("launch-why");
  const lines = decision.status === "NOT_READY" ? decision.whyNotReady : decision.whyReady;
  whyEl.innerHTML = lines.length
    ? `<ul class="launch-why-list">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`
    : "";

  renderVerification(decision);
  renderCorrelatedFindings(decision.correlatedFindings);
}

const VERIFICATION_LABELS = {
  VERIFIED: "Verified",
  STRONGLY_SUPPORTED: "Strongly supported",
  PARTIALLY_VERIFIED: "Partially verified",
  UNVERIFIED: "Unverified",
  SCAN_FAILED: "Scan failed",
};

function renderVerification(decision) {
  const panel = document.getElementById("verification-panel");
  const body = document.getElementById("verification-body");
  const completeness = decision.scanCompleteness;
  const notVerified = decision.notVerified || [];

  if (!completeness && notVerified.length === 0 && !decision.overallVerification) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  body.innerHTML = "";

  if (decision.overallVerification) {
    const badge = el("span", `verification-badge verification-badge--${decision.overallVerification.toLowerCase().replace(/_/g, "-")}`);
    badge.textContent = VERIFICATION_LABELS[decision.overallVerification] || decision.overallVerification;
    body.appendChild(badge);
  }

  if (completeness) {
    const summary = el("p", "verification-summary");
    summary.textContent = `${completeness.pagesAnalyzed} of ${completeness.pagesDiscovered} page(s) analyzed, ${completeness.categoriesAnalyzed.length} categor${completeness.categoriesAnalyzed.length === 1 ? "y" : "ies"} covered${completeness.categoriesUnavailable.length ? `, ${completeness.categoriesUnavailable.length} not yet available` : ""}.`;
    body.appendChild(summary);
  }

  if (notVerified.length > 0) {
    const list = el("ul", "verification-list");
    list.innerHTML = notVerified.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
    body.appendChild(list);
  }
}


// Session 12's cross-category root-cause correlation engine had zero
// frontend rendering until now - see PROJECT_PROGRESS.md Session 26.
// Stays hidden entirely (not an empty state) when there are no
// correlations, which is the normal, common case for most scans.
function renderCorrelatedFindings(correlatedFindings) {
  const panel = document.getElementById("correlated-panel");
  const body = document.getElementById("correlated-body");
  if (!correlatedFindings || correlatedFindings.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  body.innerHTML = "";

  const list = el("ul", "correlated-list");
  for (const c of correlatedFindings) {
    const categoryChips = c.categories.map((cat) => `<span class="correlated-category-chip">${CATEGORY_LABELS[cat] || cat}</span>`).join("");
    list.innerHTML += `
      <li class="correlated-item">
        <div class="correlated-item__head">
          <code class="correlated-item__host">${escapeHtml(c.host)}</code>
          ${categoryChips}
        </div>
        <p class="correlated-item__summary">${escapeHtml(c.summary)}</p>
      </li>`;
  }
  body.appendChild(list);
}

function renderComingSoon(report) {
  const row = document.getElementById("coming-soon-row");
  row.innerHTML = "";
  for (const key of report.categoriesNotYetAnalyzed) {
    row.appendChild(el("span", "coming-soon__pill", `${NOT_YET_LABELS[key] || key} — coming soon`));
  }
}

const METRIC_LABELS = { lcp: "LCP", inp: "INP", cls: "CLS", ttfb: "TTFB", fcp: "FCP", speedIndex: "Speed Index", tbt: "TBT" };
const STATUS_LABELS = { good: "good", "needs-improvement": "needs improvement", poor: "poor", unavailable: "unavailable" };
const PROVIDER_STATUS_MESSAGES = {
  not_configured: "Core Web Vitals unavailable for this scan — PageSpeed Insights isn't configured (no API key set on the server).",
  unavailable: "Core Web Vitals unavailable for this scan — no performance provider is configured.",
  rate_limited: "Core Web Vitals unavailable for this scan — PageSpeed Insights rate limit was reached. The rest of this report is unaffected.",
  timeout: "Core Web Vitals unavailable for this scan — PageSpeed Insights did not respond in time. The rest of this report is unaffected.",
  error: "Core Web Vitals unavailable for this scan — PageSpeed Insights could not analyze this URL. The rest of this report is unaffected.",
};

function formatMetricValue(metric) {
  if (metric.value === null) return "—";
  if (metric.unit === "unitless") return metric.value.toFixed(3);
  return `${Math.round(metric.value)}ms`;
}

function renderCoreWebVitals(report) {
  const body = document.getElementById("cwv-body");
  const subhead = document.getElementById("cwv-subhead");
  const cwv = report.coreWebVitals;
  body.innerHTML = "";

  if (cwv.providerStatus !== "available" || !cwv.evidence) {
    subhead.textContent = "Real user & lab data from Google PageSpeed Insights, when available.";
    const banner = el("div", "cwv-unavailable");
    banner.innerHTML = `<span class="cwv-unavailable__dot"></span><span>${escapeHtml(PROVIDER_STATUS_MESSAGES[cwv.providerStatus] || PROVIDER_STATUS_MESSAGES.unavailable)}</span>`;
    body.appendChild(banner);
    return;
  }

  const evidence = cwv.evidence;
  subhead.textContent = `${evidence.coverage.metricsAvailable} of ${evidence.coverage.metricsTotal} metrics available · ${cwv.providerName}`;

  const top = el("div", "cwv-top");
  top.innerHTML = `
    <div class="cwv-lh-score">
      <span class="cwv-lh-score__value">${evidence.lighthousePerformanceScore ?? "—"}</span>
      <span class="cwv-lh-score__label">Lighthouse performance score</span>
    </div>
    <span class="cwv-strategy">${escapeHtml(evidence.strategy)}</span>
  `;
  body.appendChild(top);

  const grid = el("div", "cwv-grid");
  for (const key of Object.keys(evidence.metrics)) {
    const m = evidence.metrics[key];
    const card = el("div", `cwv-metric status-${m.status}`);
    card.innerHTML = `
      <div class="cwv-metric__label">${METRIC_LABELS[key] || key}</div>
      <div class="cwv-metric__value ${m.value === null ? "unavailable" : ""}">${formatMetricValue(m)}</div>
      <div class="cwv-metric__meta">${m.value === null ? "unavailable" : `${STATUS_LABELS[m.status]} · ${m.source.replace("pagespeed-", "")}`}</div>
    `;
    grid.appendChild(card);
  }
  body.appendChild(grid);

  if (cwv.factors.length) {
    const factors = el("div", "cwv-factors");
    const rows = cwv.factors
      .map((f) => {
        const impactClass = f.scoreImpact === 0 ? "zero" : "negative";
        const impactLabel = f.scoreImpact === 0 ? "0" : String(f.scoreImpact);
        return `<div class="cwv-factor-row"><span>${METRIC_LABELS[f.metric] || f.metric}: ${f.value === null ? "unavailable" : STATUS_LABELS[f.status]}</span><span class="cwv-factor-row__impact ${impactClass}">${impactLabel}</span></div>`;
      })
      .join("");
    factors.innerHTML = `<p class="cwv-factors__title">Factors — score impact</p>${rows}`;
    body.appendChild(factors);
  }

  if (evidence.opportunities.length) {
    const opp = el("div", "cwv-opportunities");
    const rows = evidence.opportunities
      .map(
        (o) =>
          `<div class="cwv-factor-row"><span>${escapeHtml(o.title)}</span><span class="cwv-factor-row__impact">${o.estimatedSavingsMs !== null ? `~${Math.round(o.estimatedSavingsMs)}ms` : "—"}</span></div>`,
      )
      .join("");
    opp.innerHTML = `<p class="cwv-factors__title">Top opportunities (PageSpeed)</p>${rows}`;
    body.appendChild(opp);
  }
}

// Renders report.coreWebVitalsDesktop / report.mobileDesktopGaps - both
// optional, supplementary fields (see their doc comments in types.ts) that
// only exist when a scan explicitly requested the desktop PageSpeed
// strategy. Most reports won't have them; the whole panel stays hidden
// in that case rather than showing an empty/placeholder state.
function renderMobileDesktopComparison(report) {
  const panel = document.getElementById("cwv-mobile-desktop-panel");
  const body = document.getElementById("cwv-mobile-desktop-body");
  const desktop = report.coreWebVitalsDesktop;

  if (!desktop) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  body.innerHTML = "";

  if (desktop.providerStatus !== "available" || !desktop.evidence) {
    const banner = el("div", "cwv-unavailable");
    banner.innerHTML = `<span class="cwv-unavailable__dot"></span><span>Desktop: ${escapeHtml(PROVIDER_STATUS_MESSAGES[desktop.providerStatus] || PROVIDER_STATUS_MESSAGES.unavailable)}</span>`;
    body.appendChild(banner);
    return;
  }

  const gaps = report.mobileDesktopGaps || [];
  if (gaps.length > 0) {
    const gapEl = el("div", "cwv-gaps");
    const rows = gaps
      .map((g) => `<div class="cwv-factor-row cwv-factor-row--gap"><span>${METRIC_LABELS[g.metric] || g.metric}</span><span class="cwv-factor-row__impact negative">${escapeHtml(g.description)}</span></div>`)
      .join("");
    gapEl.innerHTML = `<p class="cwv-factors__title">Where mobile lags behind desktop</p>${rows}`;
    body.appendChild(gapEl);
  } else {
    const okEl = el("div", "cwv-gaps-none");
    okEl.textContent = "No significant mobile/desktop performance gaps detected.";
    body.appendChild(okEl);
  }

  const evidence = desktop.evidence;
  const desktopTop = el("div", "cwv-top");
  desktopTop.innerHTML = `
    <div class="cwv-lh-score">
      <span class="cwv-lh-score__value">${evidence.lighthousePerformanceScore ?? "—"}</span>
      <span class="cwv-lh-score__label">Desktop Lighthouse performance score</span>
    </div>
    <span class="cwv-strategy">desktop</span>
  `;
  body.appendChild(desktopTop);

  const grid = el("div", "cwv-grid");
  for (const key of Object.keys(evidence.metrics)) {
    const m = evidence.metrics[key];
    const card = el("div", `cwv-metric status-${m.status}`);
    card.innerHTML = `
      <div class="cwv-metric__label">${METRIC_LABELS[key] || key}</div>
      <div class="cwv-metric__value ${m.value === null ? "unavailable" : ""}">${formatMetricValue(m)}</div>
      <div class="cwv-metric__meta">${m.value === null ? "unavailable" : `${STATUS_LABELS[m.status]} · ${m.source.replace("pagespeed-", "")}`}</div>
    `;
    grid.appendChild(card);
  }
  body.appendChild(grid);
}

function renderPrioritizedFixes(report) {
  const panel = document.getElementById("prioritized-fixes-panel");
  const list = document.getElementById("prioritized-fixes-list");
  const fixes = report.launchDecision.prioritizedFixes || [];
  if (fixes.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  list.innerHTML = "";
  const issuesById = new Map(report.allIssues.map((i) => [i.id, i]));
  for (const fix of fixes) {
    const sampleIssue = issuesById.get(fix.issueIds[0]);
    const badges = [
      fix.blocking ? `<span class="severity-chip critical">blocker</span>` : "",
      `<span class="severity-chip ${fix.severity}">${fix.severity}</span>`,
      fix.correlatedAcrossCategories ? `<span class="fix-correlated-badge">spans ${fix.correlatedAcrossCategories} categories</span>` : "",
    ].join("");
    const li = el("li", "priority-item");
    li.innerHTML = `
      <div class="priority-item__body">
        <div class="priority-item__title-row">
          <span class="priority-item__title">${escapeHtml(fix.title)}</span>
          ${badges}
        </div>
        ${sampleIssue ? `<p class="priority-item__why">${escapeHtml(sampleIssue.whyItMatters)}</p>` : ""}
        ${sampleIssue ? `<div class="fix-row"><span class="fix-row__label">Fix</span><span>${escapeHtml(sampleIssue.recommendedFix)}</span></div>` : ""}
      </div>
    `;
    list.appendChild(li);
  }
}


function renderTechnologyStack(report) {
  const panel = document.getElementById("technology-panel");
  const body = document.getElementById("technology-body");
  const data = report.technology;
  if (!data) {
    panel.hidden = true;
    body.innerHTML = "";
    return;
  }
  panel.hidden = false;
  body.innerHTML = "";

  const summary = el("div", "technology-summary-grid");
  const summaryItems = [
    [`${data.stats.detected || 0}`, `technology${data.stats.detected === 1 ? "" : "ies"} detected`],
    [`${data.stats.categoriesRepresented ?? 0}`, "categories"],
    [`${data.stats.evidenceSignals ?? 0}`, "evidence signals"],
    [data.tentative?.length ?? 0, "tentative"],
  ];
  for (const [value, label] of summaryItems) {
    const card = el("div", "technology-summary__item");
    card.innerHTML = `<strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(String(label))}</span>`;
    summary.appendChild(card);
  }
  body.appendChild(summary);

  const toolbar = el("div", "technology-toolbar");
  toolbar.innerHTML = `
    <input class="technology-toolbar__search" type="search" placeholder="Search technologies" aria-label="Search technologies">
    <select class="technology-toolbar__category" aria-label="Filter technology category">
      <option value="all">All categories</option>
    </select>
    <select class="technology-toolbar__confidence" aria-label="Filter technology confidence">
      <option value="all">All confidence</option>
      <option value="high">High</option>
      <option value="medium">Medium</option>
    </select>`;
  body.appendChild(toolbar);

  const search = toolbar.querySelector(".technology-toolbar__search");
  const categorySelect = toolbar.querySelector(".technology-toolbar__category");
  const confidenceSelect = toolbar.querySelector(".technology-toolbar__confidence");
  const renderResults = () => {
    const query = search.value.trim().toLowerCase();
    const category = categorySelect.value;
    const confidence = confidenceSelect.value;
    const filtered = (data.detections || []).filter((tech) => {
      if (category !== "all" && tech.category !== category) return false;
      if (confidence !== "all" && tech.confidence !== confidence) return false;
      if (!query) return true;
      const hay = [tech.name, tech.slug, ...(tech.metadata?.aliases || [])].join(" ").toLowerCase();
      return hay.includes(query);
    });

    const grouped = new Map();
    for (const tech of filtered) {
      if (!grouped.has(tech.category)) grouped.set(tech.category, []);
      grouped.get(tech.category).push(tech);
    }
    const labels = {
      cms: "CMS", framework: "Frameworks & Libraries", ecommerce: "Ecommerce", payments: "Payments",
      analytics: "Analytics", infrastructure: "CDN / Infrastructure", marketing: "Marketing & CRM",
      consent: "Consent & Privacy", security: "Security", search: "Site Search", forms: "Forms",
      media: "Video & Media", fonts: "Fonts", plugin: "Plugins & Extensions", other: "Other",
    };
    const order = ["cms", "framework", "ecommerce", "payments", "analytics", "marketing", "consent", "security", "infrastructure", "search", "forms", "media", "fonts", "plugin", "other"];

    result.innerHTML = "";
    let rendered = 0;
    for (const cat of order) {
      const items = grouped.get(cat);
      if (!items?.length) continue;
      rendered += items.length;
      const group = el("div", "technology-group");
      group.innerHTML = `<h4 class="technology-group__title">${escapeHtml(labels[cat] || cat)}</h4>`;
      const list = el("div", "technology-grid");
      for (const tech of items) list.appendChild(renderTechnologyCard(tech));
      group.appendChild(list);
      result.appendChild(group);
    }
    empty.hidden = rendered !== 0;
    count.textContent = `${rendered} shown`;
  };

  const categoryIds = [...new Set((data.detections || []).map((t) => t.category))].sort();
  const categoryLabels = {
    cms: "CMS", framework: "Frameworks & Libraries", ecommerce: "Ecommerce", payments: "Payments",
    analytics: "Analytics", infrastructure: "CDN / Infrastructure", marketing: "Marketing & CRM",
    consent: "Consent & Privacy", security: "Security", search: "Site Search", forms: "Forms",
    media: "Video & Media", fonts: "Fonts", plugin: "Plugins & Extensions", other: "Other",
  };
  for (const id of categoryIds) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = categoryLabels[id] || id;
    categorySelect.appendChild(option);
  }

  const result = el("div", "technology-results");
  const empty = el("p", "technology-empty", "No technologies match the current filters.");
  const count = el("div", "technology-toolbar__count", "");
  body.appendChild(count);
  body.appendChild(result);
  body.appendChild(empty);

  search.addEventListener("input", renderResults);
  categorySelect.addEventListener("change", renderResults);
  confidenceSelect.addEventListener("change", renderResults);
  renderResults();

  if ((data.tentative || []).length) {
    const details = el("details", "technology-tentative");
    const summaryText = el("summary", null, `${data.tentative.length} tentative detection${data.tentative.length === 1 ? "" : "s"} (weak signal — not treated as fact)`);
    details.appendChild(summaryText);
    const list = el("div", "technology-grid");
    for (const tech of data.tentative) list.appendChild(renderTechnologyCard(tech, true));
    details.appendChild(list);
    body.appendChild(details);
  }

  if (report.siteTechnology) {
    renderSiteTechnologySummary(body, report.siteTechnology);
  }
}

function renderSiteTechnologySummary(body, site) {
  const details = el("details", "technology-site-summary");
  const summary = el("summary", null, `Site-wide technology coverage · ${site.totalPages} pages`);
  details.appendChild(summary);
  const list = el("div", "technology-site-summary__list");
  for (const item of (site.coverage || []).slice(0, 20)) {
    const row = el("div", "technology-site-summary__row");
    row.innerHTML = `<span>${escapeHtml(item.name)}</span><strong>${item.coveragePct}%</strong><small>${item.pageCount}/${item.totalPages} pages${item.versions.length ? ` · ${escapeHtml(item.versions.join(", "))}` : ""}</small>`;
    list.appendChild(row);
  }
  details.appendChild(list);
  if ((site.observations || []).length) {
    const obs = el("div", "technology-site-summary__observations");
    for (const o of site.observations.slice(0, 8)) {
      const p = el("p", null, escapeHtml(o.summary));
      obs.appendChild(p);
    }
    details.appendChild(obs);
  }
  body.appendChild(details);
}

function renderTechnologyCard(tech, tentative = false) {
  const card = el("article", `technology-card${tentative ? " technology-card--tentative" : ""}`);
  const link = document.createElement("a");
  link.className = "technology-card__link";
  link.href = tech.homepage;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", `${tech.name} official homepage, opens in a new tab`);

  const icon = document.createElement("img");
  icon.className = "technology-card__icon";
  icon.src = `https://cdn.simpleicons.org/${encodeURIComponent(tech.icon)}`;
  icon.alt = "";
  icon.width = 28;
  icon.height = 28;
  icon.loading = "lazy";
  icon.referrerPolicy = "no-referrer";
  icon.addEventListener("error", () => {
    if (icon.dataset.fallback === "1") return;
    icon.dataset.fallback = "1";
    const fallback = document.createElement("span");
    fallback.className = "technology-card__icon technology-card__icon--fallback";
    fallback.textContent = tech.name.slice(0, 1).toUpperCase();
    fallback.setAttribute("aria-hidden", "true");
    link.replaceChild(fallback, icon);
  });

  const info = el("div", "technology-card__info");
  const relationText = tech.implied ? " · inferred" : "";
  const exposed = tech.technologyRisk?.exposedVersion ? " · version public" : "";
  info.innerHTML = `
    <div class="technology-card__name-row">
      <span class="technology-card__name">${escapeHtml(tech.name)}</span>
      ${tech.version ? `<span class="technology-card__version">${escapeHtml(tech.version)}</span>` : ""}
      <span class="technology-card__external" aria-hidden="true">↗</span>
    </div>
    <div class="technology-card__meta">${escapeHtml(tech.confidence)} confidence${relationText}${exposed}</div>
    <div class="technology-card__evidence-count">${tech.evidence.length} evidence signal${tech.evidence.length === 1 ? "" : "s"}</div>`;
  link.append(icon, info);
  card.appendChild(link);

  const details = el("details", "technology-card__details");
  const summary = el("summary", "technology-card__details-summary", "Why detected");
  details.appendChild(summary);
  if (tech.explanation) details.appendChild(el("p", "technology-card__explanation", tech.explanation));

  if (tech.versionEvidence?.length) {
    const v = el("p", "technology-card__version-evidence", `Version ${tech.versionConfidence || "unknown"}: ${tech.versionEvidence.map((x) => `${x.version} from ${x.source}`).join("; ")}`);
    details.appendChild(v);
  }

  if (tech.relationships) {
    const related = [
      ...(tech.relationships.requires || []).map((x) => `requires ${x}`),
      ...(tech.relationships.impliedBy || []).map((x) => `implied by ${x}`),
      ...(tech.relationships.requiredBy || []).map((x) => `required by ${x}`),
    ];
    if (related.length) details.appendChild(el("p", "technology-card__related", related.join(" · ")));
  }

  if (tech.auditRelevance) {
    details.appendChild(el("p", "technology-card__audit", `Audit relevance: ${tech.auditRelevance.categories.join(", ")} — ${tech.auditRelevance.reason}`));
  }

  const list = el("ul", "technology-card__evidence-list");
  for (const evidence of tech.evidence || []) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="technology-card__source">${escapeHtml(evidence.role || "direct")} · ${escapeHtml(evidence.source)}</span><code>${escapeHtml(evidence.matched)}</code>`;
    list.appendChild(li);
  }
  details.appendChild(list);
  card.appendChild(details);
  return card;
}

function renderPriorityList(report) {
  const list = document.getElementById("priority-list");
  list.innerHTML = "";
  if (report.topPriorityIssues.length === 0) {
    list.appendChild(el("li", "empty-state", "No high-priority issues found. Nice work."));
    return;
  }
  for (const issue of report.topPriorityIssues) {
    const li = el("li", "priority-item");
    li.innerHTML = `
      <div class="priority-item__body">
        <div class="priority-item__title-row">
          <span class="priority-item__title">${escapeHtml(issue.title)}</span>
          <span class="severity-chip ${issue.severity}">${issue.severity}</span>
        </div>
        <p class="priority-item__why">${escapeHtml(issue.whyItMatters)}</p>
        ${renderEvidenceRow(issue)}
        <div class="fix-row"><span class="fix-row__label">Fix</span><span>${escapeHtml(issue.recommendedFix)}</span></div>
      </div>
    `;
    list.appendChild(li);
  }
}

function renderEvidenceRow(issue) {
  if (!issue.evidence.length) return "";
  const tags = issue.evidence
    .map((ev) => `<span class="evidence-tag">${escapeHtml(ev.label)}: <b>${escapeHtml(ev.value)}</b></span>`)
    .join("");
  return `<div class="evidence-row">${tags}</div>`;
}

function renderFilterTabs(report) {
  const tabs = document.getElementById("filter-tabs");
  tabs.innerHTML = "";
  const options = ["all", ...report.categoriesAnalyzed];
  for (const opt of options) {
    const btn = el(
      "button",
      "filter-tab",
      opt === "all" ? `All (${report.allIssues.length})` : `${CATEGORY_LABELS[opt]} (${report.allIssues.filter((i) => i.category === opt).length})`,
    );
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(opt === activeFilter));
    btn.addEventListener("click", () => {
      activeFilter = opt;
      renderFilterTabs(currentReport);
      renderIssueList(currentReport);
    });
    tabs.appendChild(btn);
  }
}

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function renderIssueList(report) {
  document.getElementById("findings-count").textContent = `${report.issueCounts.total} issues — ${report.issueCounts.critical} critical, ${report.issueCounts.high} high, ${report.issueCounts.medium} medium, ${report.issueCounts.low} low`;

  const container = document.getElementById("issue-list");
  container.innerHTML = "";

  const filtered = report.allIssues
    .filter((i) => activeFilter === "all" || i.category === activeFilter)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  if (filtered.length === 0) {
    container.appendChild(el("div", "empty-state", "No findings in this category."));
    return;
  }

  for (const issue of filtered) {
    const row = el("div", "issue-row");
    const details = el("details");
    details.innerHTML = `
      <summary class="issue-row__summary">
        <span class="issue-row__cat">${CATEGORY_LABELS[issue.category]}</span>
        <span class="severity-chip ${issue.severity}">${issue.severity}</span>
        <span class="issue-row__title">${escapeHtml(issue.title)}</span>
        <span class="issue-row__chevron">›</span>
      </summary>
      <div class="issue-row__detail">
        <p class="priority-item__why">${escapeHtml(issue.whyItMatters)}</p>
        ${issue.estimatedImpact ? `<p class="priority-item__why"><em>Impact:</em> ${escapeHtml(issue.estimatedImpact)}</p>` : ""}
        ${renderEvidenceRow(issue)}
        <div class="fix-row"><span class="fix-row__label">Fix</span><span>${escapeHtml(issue.recommendedFix)}</span></div>
        <p style="margin-top:8px; font-size:12px; color:var(--ink-faint); font-family:var(--font-mono)">
          affected: ${escapeHtml(issue.affected)} · difficulty: ${issue.difficulty} · source: ${issue.source}
        </p>
      </div>
    `;
    row.appendChild(details);
    container.appendChild(row);
  }
}

function renderEvidenceLog(report) {
  const pre = document.getElementById("evidence-log");
  pre.textContent = JSON.stringify(report.evidenceLog, null, 2);
}

function renderAccessibilityCoverage(report) {
  const body = document.getElementById("a11y-coverage-body");
  const coverage = report.accessibilityCoverage;
  body.innerHTML = `
    <div class="a11y-coverage-col">
      <p class="a11y-coverage-label">Checked</p>
      <ul class="a11y-coverage-list a11y-coverage-list--checked">
        ${coverage.checkedAreas.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}
      </ul>
    </div>
    <div class="a11y-coverage-col">
      <p class="a11y-coverage-label">Not verifiable by static analysis</p>
      <ul class="a11y-coverage-list a11y-coverage-list--unverified">
        ${coverage.notVerifiable.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
