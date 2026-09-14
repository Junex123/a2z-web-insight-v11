import type { PerformanceProviderResult, PerformanceVerificationCheck, PerformanceVerificationSummary, ResourceIntelligence } from "../types.js";

/**
 * Same purpose and rules as analysis/seoVerification.ts (see that
 * file's doc comment for the full reasoning) applied to Performance:
 * turns evidence the pipeline already collected into an explicit
 * VERIFIED/FAILED/WARNING/UNVERIFIED/NOT_APPLICABLE statement, and
 * never reports something this scan didn't actually check as if it
 * passed.
 */
export function buildPerformanceVerificationSummary(
  providerResult: PerformanceProviderResult,
  resourceIntelligence: ResourceIntelligence,
): PerformanceVerificationSummary {
  const checks: PerformanceVerificationCheck[] = [
    verifyCoreWebVitals(providerResult),
    verifyResourceProbe(resourceIntelligence),
    verifyBrowserRuntimeMetrics(),
  ];
  return { checks };
}

function verifyCoreWebVitals(providerResult: PerformanceProviderResult): PerformanceVerificationCheck {
  switch (providerResult.status) {
    case "available":
      return {
        check: "core_web_vitals",
        label: "Core Web Vitals (PageSpeed Insights)",
        state: "verified",
        detail: `Retrieved from PageSpeed Insights (${providerResult.evidence?.coverage.metricsAvailable ?? 0} of ${providerResult.evidence?.coverage.metricsTotal ?? 0} metrics available).`,
      };
    case "not_configured":
      return {
        check: "core_web_vitals",
        label: "Core Web Vitals (PageSpeed Insights)",
        state: "not_applicable",
        detail: "No PageSpeed Insights API key is configured for this deployment - Core Web Vitals were not requested.",
      };
    case "rate_limited":
      return { check: "core_web_vitals", label: "Core Web Vitals (PageSpeed Insights)", state: "unverified", detail: "PageSpeed Insights rate limit was exceeded - Core Web Vitals could not be retrieved for this scan." };
    case "timeout":
      return { check: "core_web_vitals", label: "Core Web Vitals (PageSpeed Insights)", state: "unverified", detail: "PageSpeed Insights did not respond in time - Core Web Vitals could not be retrieved for this scan." };
    default:
      return { check: "core_web_vitals", label: "Core Web Vitals (PageSpeed Insights)", state: "unverified", detail: providerResult.errorMessage ?? "Core Web Vitals could not be retrieved for this scan." };
  }
}

function verifyResourceProbe(intel: ResourceIntelligence): PerformanceVerificationCheck {
  if (intel.candidateCount === 0) {
    return { check: "resource_probe", label: "Sub-resource inventory (scripts/CSS/images/fonts)", state: "not_applicable", detail: "This page references no probeable scripts, stylesheets, images, or fonts." };
  }
  if (intel.truncated) {
    return {
      check: "resource_probe",
      label: "Sub-resource inventory (scripts/CSS/images/fonts)",
      state: "warning",
      detail: `This page references ${intel.candidateCount} candidate resources; only the first ${intel.probedCount} were probed (bounded to avoid unbounded fan-out). Totals below are a partial sample, not the whole page.`,
    };
  }
  const unprobed = intel.entries.filter((e) => !e.probed).length;
  if (unprobed > 0) {
    return {
      check: "resource_probe",
      label: "Sub-resource inventory (scripts/CSS/images/fonts)",
      state: "warning",
      detail: `${unprobed} of ${intel.probedCount} candidate resources could not be reached (timeout/network error/blocked host) - their size/caching/compression could not be determined.`,
    };
  }
  return {
    check: "resource_probe",
    label: "Sub-resource inventory (scripts/CSS/images/fonts)",
    state: "verified",
    detail: `All ${intel.probedCount} referenced resources were probed via HTTP HEAD.`,
  };
}

/**
 * These always come back unverified on this pipeline - there is no
 * browser/runtime collector in this checkout (confirmed by inspecting
 * the repository, not assumed). PageSpeed Insights' own Lighthouse lab
 * run does execute in a real (Google-hosted) browser, but that data
 * flows through `core_web_vitals` above; this check is specifically
 * about runtime measurements THIS system would capture directly
 * (actual render-blocking confirmation, network waterfalls, long
 * tasks, layout-shift element attribution), which it does not do.
 */
function verifyBrowserRuntimeMetrics(): PerformanceVerificationCheck {
  return {
    check: "browser_runtime",
    label: "Browser/runtime-confirmed behavior (render-blocking, waterfalls, long tasks)",
    state: "unverified",
    detail: "This scan has no browser/runtime collector - it cannot confirm actual render-blocking behavior, network waterfalls, main-thread long tasks, or runtime layout shift. What's reported instead are static HTML/HTTP signals (e.g. a script with no async/defer looks render-blocking) and, when configured, PageSpeed Insights' own Lighthouse lab measurements - neither is a substitute for this system directly observing a real page load.",
  };
}
