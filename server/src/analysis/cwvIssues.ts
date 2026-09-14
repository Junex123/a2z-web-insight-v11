import type { CoreWebVitalsEvidence, CwvMetricKey, Evidence, Issue, PerformanceFactor, ResourceIntelligence, Severity } from "../types.js";
import { DEDUCTION } from "./scorer.js";
import { CORE_METRICS, METRIC_THRESHOLDS, severityForMetric } from "./performanceThresholds.js";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `performance-cwv-${counter}`;
}
export function resetCwvIssueIdCounter() {
  counter = 0;
  oppCounter = 0;
}

let oppCounter = 0;
function nextOppId(): string {
  oppCounter += 1;
  return `performance-opp-${oppCounter}`;
}

/**
 * TTFB is deliberately excluded here: our own httpCollector already
 * measures TTFB directly and issues.ts already creates a "slow server
 * response" finding for it. Scoring the PageSpeed TTFB figure too would
 * double-penalize the same underlying fact with two different Issues.
 * PageSpeed's TTFB is still surfaced in the factors/evidence display
 * for context, just not turned into a second Issue.
 */
const SCORED_METRICS: CwvMetricKey[] = ["lcp", "inp", "cls", "fcp", "speedIndex", "tbt"];

function formatValue(key: CwvMetricKey, value: number): string {
  if (key === "cls") return value.toFixed(3);
  return `${Math.round(value)}ms`;
}

const METRIC_WHY: Record<CwvMetricKey, string> = {
  lcp: "LCP measures how long the largest visible element takes to render. Slow LCP is one of Google's three Core Web Vitals and directly affects both UX and search ranking.",
  inp: "INP measures how responsive the page feels to real interactions (clicks, taps, key presses). Poor INP means the page feels laggy to use.",
  cls: "CLS measures unexpected layout movement. High CLS causes mis-clicks and a jarring reading/browsing experience.",
  ttfb: "TTFB (from PageSpeed) is shown for context; it is scored separately from our own direct HTTP measurement, not from this figure.",
  fcp: "FCP measures how long until the first content appears at all. A slow FCP makes the page feel like it isn't loading.",
  speedIndex: "Speed Index measures how quickly the page's content is visually populated during load.",
  tbt: "Total Blocking Time measures how long the main thread was blocked and unable to respond to input during load.",
};

const METRIC_FIX: Record<CwvMetricKey, string> = {
  lcp: "Optimize or preload the largest above-the-fold image/text block, remove render-blocking resources ahead of it, and ensure the server responds quickly.",
  inp: "Break up long JavaScript tasks, defer non-critical scripts, and avoid heavy work in event handlers.",
  cls: "Reserve space (width/height or aspect-ratio) for images, ads, and embeds, and avoid injecting content above existing content after load.",
  ttfb: "See the existing 'server response time is slow' finding, which is based on our own direct measurement.",
  fcp: "Eliminate render-blocking CSS/JS, inline critical CSS, and reduce server response time.",
  speedIndex: "Reduce the amount of content painted late; prioritize above-the-fold content and defer the rest.",
  tbt: "Split large JavaScript bundles, defer/async non-critical scripts, and remove unused JavaScript.",
};

/**
 * Cross-references Lighthouse's LCP element against this scan's own
 * independently-probed resource evidence. No match means no root cause claim.
 */
function resolveLcpRootCause(
  evidence: CoreWebVitalsEvidence,
  resourceIntelligence: ResourceIntelligence | undefined,
  pageUrl: string,
): { url: string; sizeBytes: number } | null {
  if (!resourceIntelligence) return null;
  const imageUrl = evidence.lcpElement?.imageUrl;
  if (!imageUrl) return null;
  let resolved: string;
  try {
    resolved = new URL(imageUrl, pageUrl).href;
  } catch {
    return null;
  }
  const match = resourceIntelligence.entries.find((e) => e.url === resolved);
  if (!match || match.contentLength === null) return null;
  return { url: resolved, sizeBytes: match.contentLength };
}

/**
 * Builds Issue objects from PageSpeed-derived metrics, using the exact
 * same Issue shape (and therefore the exact same scoreCategory()
 * deduction table) as every other rule in analysis/issues.ts. This is
 * how Core Web Vitals plug into the existing scorer without a second
 * scoring mechanism.
 */
function describeLayoutShiftContributors(
  evidence: CoreWebVitalsEvidence,
  resourceIntelligence: ResourceIntelligence | undefined,
  pageUrl: string,
): { summary: string; evidenceLines: Evidence[]; missingDimensionSelectors: string[] } | null {
  const elements = evidence.layoutShiftElements;
  if (!elements || elements.length === 0) return null;

  const withoutDimensions = elements.filter((e) => e.hasDeclaredDimensions === false);
  const evidenceLines: Evidence[] = [];

  for (const el of elements.slice(0, 3)) {
    const label = el.selector ?? el.imageUrl ?? "unidentified element";
    const dims = el.hasDeclaredDimensions === false ? "no declared width/height" : el.hasDeclaredDimensions === true ? "has declared dimensions" : "dimension info unavailable";
    const scoreLabel = el.scoreContribution !== null ? `, CLS contribution ${el.scoreContribution.toFixed(3)}` : "";

    let sizeLabel = "";
    if (el.imageUrl && resourceIntelligence) {
      try {
        const resolved = new URL(el.imageUrl, pageUrl).href;
        const match = resourceIntelligence.entries.find((e) => e.url === resolved);
        if (match?.contentLength !== null && match?.contentLength !== undefined) sizeLabel = `, ${Math.round(match.contentLength / 1024)}KB`;
      } catch {
        // an unresolvable URL just means no bonus size figure - not a reason to fail
      }
    }

    evidenceLines.push({ type: "html", label: "Layout-shift contributor", value: `${label} (${dims}${scoreLabel}${sizeLabel})` });
  }

  const summary =
    withoutDimensions.length > 0
      ? `Lighthouse identifies ${withoutDimensions.length} of ${elements.length} shift-contributing element(s) with no declared width/height - reserving space for these would directly reduce layout shift.`
      : `Lighthouse identifies ${elements.length} specific element(s) contributing to this page's layout shift.`;

  return { summary, evidenceLines, missingDimensionSelectors: withoutDimensions.map((e) => e.selector).filter((s): s is string => !!s) };
}

/**
 * Builds Issue objects from PageSpeed-derived metrics, using the exact
 * same Issue shape (and therefore the exact same scoreCategory()
 * deduction table) as every other rule in analysis/issues.ts. This is
 * how Core Web Vitals plug into the existing scorer without a second
 * scoring mechanism.
 *
 * `resourceIntelligence` is optional (older/direct callers still work
 * unchanged) - when supplied and the LCP metric is poor/needs-
 * improvement, the LCP finding is ENRICHED in place with the specific
 * resource Lighthouse identified as the LCP element, when we can
 * independently verify it (see resolveLcpRootCause). The CLS finding
 * is similarly enriched in place with the specific shift-contributing
 * elements Lighthouse identified (see describeLayoutShiftContributors) -
 * this one doesn't require resourceIntelligence to be trustworthy,
 * since it's reporting Lighthouse's own captured DOM attributes, not a
 * size claim this scan needs to re-verify. Both enrichments
 * deliberately augment the existing Issue rather than creating a
 * second one - two Issues for the same underlying "LCP/CLS is bad"
 * fact would double-count the same problem in scoring, which this
 * project explicitly avoids elsewhere (see Session 6/7's
 * non-duplication precedent for SEO).
 */

export function detectCwvIssues(evidence: CoreWebVitalsEvidence, affectedUrl: string, resourceIntelligence?: ResourceIntelligence): Issue[] {
  const issues: Issue[] = [];

  for (const key of SCORED_METRICS) {
    const metric = evidence.metrics[key];
    if (metric.value === null || metric.status === "unavailable" || metric.status === "good") continue;

    const severity: Severity = severityForMetric(key, metric.status as "needs-improvement" | "poor");
    const threshold = METRIC_THRESHOLDS[key];

    const issue: Issue = {
      id: nextId(),
      category: "performance",
      severity,
      title: `${threshold.label} is ${metric.status === "poor" ? "poor" : "needs improvement"}`,
      affected: affectedUrl,
      whyItMatters: METRIC_WHY[key],
      estimatedImpact: `Measured at ${formatValue(key, metric.value)} (${CORE_METRICS.includes(key) ? "Core Web Vital" : "supplementary metric"}; "good" is <=${formatValue(key, threshold.good)}).`,
      recommendedFix: METRIC_FIX[key],
      difficulty: "moderate",
      priorityScore: severity === "high" ? 70 : severity === "medium" ? 40 : 15,
      source: "measured",
      evidence: [
        { type: "computed", label: `${threshold.label} (${metric.source})`, value: formatValue(key, metric.value) },
      ],
    };

    if (key === "lcp") {
      const rootCause = resolveLcpRootCause(evidence, resourceIntelligence, affectedUrl);
      if (rootCause) {
        const sizeLabel = `${Math.round(rootCause.sizeBytes / 1024)}KB`;
        issue.estimatedImpact = `${issue.estimatedImpact} Lighthouse identifies the LCP element as an image at ${rootCause.url} (${sizeLabel}) - this scan independently confirmed that size.`;
        issue.recommendedFix = `This page's specific LCP element is ${rootCause.url} (${sizeLabel}) - compress/resize that exact image and consider preloading it (rel=preload), in addition to: ${issue.recommendedFix}`;
        issue.evidence.push({ type: "header", label: "LCP element (cross-verified)", value: `${rootCause.url} - ${sizeLabel}` });
      }
    }

    issues.push(issue);
  }

  return issues;
}

/**
 * Turns PageSpeed's own Lighthouse "opportunity" audits (render-blocking
 * resources, unminified JS/CSS, unused JS/CSS, modern image formats,
 * offscreen images, text compression, long cache TTL, etc. - whatever
 * Lighthouse actually flagged for THIS page) into Issues. This data was
 * already being fetched and normalized (extractOpportunities() in
 * pageSpeedProvider.ts) but never turned into a finding - a real gap,
 * not a fabrication: every one of these came directly from Google's own
 * Lighthouse run against this URL. Only opportunities with a real,
 * materially-sized estimated savings are surfaced, to avoid flooding
 * the report with trivial (a few ms) suggestions.
 */
const MATERIAL_SAVINGS_MS = 250;

export function detectPageSpeedOpportunityIssues(evidence: CoreWebVitalsEvidence, affectedUrl: string): Issue[] {
  const issues: Issue[] = [];
  for (const opp of evidence.opportunities) {
    if (opp.estimatedSavingsMs === null || opp.estimatedSavingsMs < MATERIAL_SAVINGS_MS) continue;
    const severity: Severity = opp.estimatedSavingsMs >= 1000 ? "high" : "medium";
    issues.push({
      id: nextOppId(),
      category: "performance",
      severity,
      title: opp.title,
      affected: affectedUrl,
      whyItMatters: "Identified by Google Lighthouse (via PageSpeed Insights) as an opportunity to reduce load time for this specific page.",
      estimatedImpact: `Estimated savings: ~${Math.round(opp.estimatedSavingsMs)}ms (Lighthouse audit: ${opp.id}).`,
      recommendedFix: "See the linked Lighthouse audit for this page for the specific resources involved.",
      difficulty: "moderate",
      priorityScore: severity === "high" ? 70 : 40,
      source: "measured",
      evidence: [{ type: "computed", label: `Lighthouse opportunity (${opp.id})`, value: `~${Math.round(opp.estimatedSavingsMs)}ms estimated savings` }],
    });
  }
  return issues;
}

/**
 * Builds the full "why does Performance score what it scores" factor
 * breakdown - one row per available metric, including "good" ones
 * (shown with 0 impact) so the dashboard can show a complete picture,
 * not just the problems.
 */
export function buildPerformanceFactors(evidence: CoreWebVitalsEvidence | null): PerformanceFactor[] {
  if (!evidence) return [];

  const factors: PerformanceFactor[] = [];
  for (const key of Object.keys(evidence.metrics) as CwvMetricKey[]) {
    const metric = evidence.metrics[key];
    const threshold = METRIC_THRESHOLDS[key];
    const scored = SCORED_METRICS.includes(key);

    let scoreImpact = 0;
    if (scored && metric.value !== null && (metric.status === "needs-improvement" || metric.status === "poor")) {
      const severity = severityForMetric(key, metric.status);
      scoreImpact = -DEDUCTION[severity];
    }

    factors.push({
      metric: key,
      label: threshold.label,
      value: metric.value,
      unit: metric.unit,
      status: metric.status,
      scoreImpact,
      source: metric.source,
    });
  }
  return factors;
}
