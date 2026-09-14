import type { CwvMetricKey, MetricStatus, Severity } from "../types.js";

/**
 * Web Vitals thresholds, per Google's published "good / needs
 * improvement / poor" boundaries (web.dev/articles/cwv, and the
 * equivalent Lighthouse/CrUX scoring boundaries for the supplementary
 * metrics). These are industry-standard reference numbers, not
 * something this codebase invented - they're centralized here so nobody
 * has to go hunting for a magic "2500" or "0.1" buried in a rule file.
 */
export interface MetricThreshold {
  key: CwvMetricKey;
  label: string;
  unit: "ms" | "unitless";
  /** value <= this => "good" */
  good: number;
  /** value <= this (and > good) => "needs-improvement"; above => "poor" */
  needsImprovement: number;
}

export const METRIC_THRESHOLDS: Record<CwvMetricKey, MetricThreshold> = {
  lcp: { key: "lcp", label: "Largest Contentful Paint", unit: "ms", good: 2500, needsImprovement: 4000 },
  inp: { key: "inp", label: "Interaction to Next Paint", unit: "ms", good: 200, needsImprovement: 500 },
  cls: { key: "cls", label: "Cumulative Layout Shift", unit: "unitless", good: 0.1, needsImprovement: 0.25 },
  ttfb: { key: "ttfb", label: "Time to First Byte", unit: "ms", good: 800, needsImprovement: 1800 },
  fcp: { key: "fcp", label: "First Contentful Paint", unit: "ms", good: 1800, needsImprovement: 3000 },
  speedIndex: { key: "speedIndex", label: "Speed Index", unit: "ms", good: 3400, needsImprovement: 5800 },
  tbt: { key: "tbt", label: "Total Blocking Time", unit: "ms", good: 200, needsImprovement: 600 },
};

export function classifyMetric(key: CwvMetricKey, value: number): MetricStatus {
  const t = METRIC_THRESHOLDS[key];
  if (value <= t.good) return "good";
  if (value <= t.needsImprovement) return "needs-improvement";
  return "poor";
}

/**
 * The three "Core" Web Vitals (Google's primary UX/ranking signal set)
 * are weighted more heavily than the supplementary Lighthouse metrics.
 * Mapping to the app's existing Severity levels means these findings
 * flow through the exact same scoreCategory() deduction table as every
 * other issue in the app (see analysis/scorer.ts) - no second scoring
 * mechanism is introduced.
 */
export const CORE_METRICS: CwvMetricKey[] = ["lcp", "inp", "cls"];

export const CORE_METRIC_SEVERITY: Record<"needs-improvement" | "poor", Severity> = {
  "needs-improvement": "medium",
  poor: "high",
};

export const SUPPLEMENTARY_METRIC_SEVERITY: Record<"needs-improvement" | "poor", Severity> = {
  "needs-improvement": "low",
  poor: "medium",
};

export function severityForMetric(key: CwvMetricKey, status: "needs-improvement" | "poor"): Severity {
  const table = CORE_METRICS.includes(key) ? CORE_METRIC_SEVERITY : SUPPLEMENTARY_METRIC_SEVERITY;
  return table[status];
}
