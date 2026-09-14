import type {
  AccessibilityCoverage,
  Category,
  CoreWebVitalsReport,
  FetchQuality,
  FindingPriority,
  Issue,
  LaunchReadinessReport,
  PrioritizedFinding,
  ReadinessVerdict,
  RuntimeVerificationReport,
  UnverifiedArea,
} from "../types.js";

/**
 * Deterministic launch-readiness verdict, built entirely on top of data
 * this project already measures - no new evidence collection, no AI
 * judgment call. Session 7 addition (see PROJECT_PROGRESS.md).
 *
 * PRIORITY IS DERIVED FROM SEVERITY, NOT REINVENTED. `Issue.severity`
 * and `RuntimeFinding.severity` are already the product of deterministic
 * rules in issues.ts/accessibilityIssues.ts/runtimeFindings.ts - a
 * broken contact form or serious security problem is already
 * "critical"/"high" there. This function does not re-judge severity; it
 * only translates the existing scale into a launch-facing bucket:
 *   critical -> must_fix (a launch blocker)
 *   high     -> important (should fix before launch, not a hard blocker)
 *   medium/low -> improvement (worth doing, not launch-blocking)
 * This was chosen over inventing a second, parallel severity judgment
 * specifically to avoid two systems disagreeing with each other about
 * how bad the same finding is - see Architecture Decisions.
 *
 * UNVERIFIED NEVER SILENTLY BECOMES A PASS OR A FAILURE. Core Web
 * Vitals (when PageSpeed isn't configured/available) and browser/
 * runtime verification (when not requested, or when it failed to run)
 * are surfaced in `unverifiedAreas`, completely separate from
 * `mustFix`/`important`/`improvements` - an area Web Insight could not
 * actually check never counts toward, or against, the verdict.
 */
export function computeLaunchReadiness(input: {
  allIssues: Issue[];
  coreWebVitals: CoreWebVitalsReport;
  runtimeVerification?: RuntimeVerificationReport;
  accessibilityCoverage: AccessibilityCoverage;
  fetchQuality: FetchQuality;
}): LaunchReadinessReport {
  const CONTENT_DERIVED_CATEGORIES: Category[] = ["seo", "accessibility"];
  const fetchIsUnusable = input.fetchQuality !== "usable";
  const consideredIssues = fetchIsUnusable
    ? input.allIssues.filter((issue) => !CONTENT_DERIVED_CATEGORIES.includes(issue.category))
    : input.allIssues;

  const findings: PrioritizedFinding[] = [
    ...consideredIssues.map((issue) => ({ priority: priorityFor(issue.severity), category: issue.category, issue })),
    ...(input.runtimeVerification?.status === "completed"
      ? input.runtimeVerification.findings.map((finding) => ({
          priority: priorityFor(finding.severity),
          category: "runtime" as const,
          issue: finding,
        }))
      : []),
  ];

  const mustFix = findings.filter((f) => f.priority === "must_fix");
  const important = findings.filter((f) => f.priority === "important");
  const improvements = findings.filter((f) => f.priority === "improvement");

  const CATEGORIES: Category[] = ["performance", "seo", "security", "accessibility", "ux", "responsiveness"];
  const passedCategories = CATEGORIES.filter(
    (c) => !(fetchIsUnusable && CONTENT_DERIVED_CATEGORIES.includes(c)) && !consideredIssues.some((i) => i.category === c),
  );

  const unverifiedAreas: UnverifiedArea[] = [];
  if (fetchIsUnusable) {
    const reason = input.fetchQuality === "empty"
      ? "The page returned an empty response body, so there was no real content to check."
      : "The page's response had no analyzable content (no title, heading, meta description, or images), so there was no real content to check.";
    unverifiedAreas.push({ area: "SEO (page content analysis)", reason });
    unverifiedAreas.push({ area: "Accessibility (page content analysis)", reason });
  }
  if (input.coreWebVitals.providerStatus !== "available") {
    unverifiedAreas.push({
      area: "Core Web Vitals (real-user performance metrics)",
      reason: input.coreWebVitals.errorMessage ?? describeCwvStatus(input.coreWebVitals.providerStatus),
    });
  }
  if (!input.runtimeVerification) {
    unverifiedAreas.push({
      area: "Real-browser checks (JavaScript errors, broken interactive elements, rendered content)",
      reason: "Not requested for this scan - browser verification is opt-in because it launches a real browser.",
    });
  } else if (input.runtimeVerification.status === "error") {
    unverifiedAreas.push({
      area: "Real-browser checks (JavaScript errors, broken interactive elements, rendered content)",
      reason: input.runtimeVerification.errorMessage ?? "Browser verification did not complete for this scan.",
    });
  }
  for (const area of input.accessibilityCoverage.notVerifiable) {
    unverifiedAreas.push({ area, reason: "Requires rendering/executing the page, not just static markup analysis." });
  }

  const verdict: ReadinessVerdict = mustFix.length > 0 ? "not_ready" : important.length > 0 ? "almost_ready" : "ready";
  const { headline, summary } = describeVerdict(verdict, mustFix.length, important.length);

  return { verdict, headline, summary, mustFix, important, improvements, passedCategories, unverifiedAreas };
}

function priorityFor(severity: Issue["severity"]): FindingPriority {
  if (severity === "critical") return "must_fix";
  if (severity === "high") return "important";
  return "improvement";
}

function describeCwvStatus(status: CoreWebVitalsReport["providerStatus"]): string {
  switch (status) {
    case "not_configured":
      return "No PageSpeed Insights API key is configured for this scan.";
    case "rate_limited":
      return "PageSpeed Insights rate-limited this request.";
    case "timeout":
      return "The PageSpeed Insights request timed out.";
    case "error":
      return "The PageSpeed Insights request failed.";
    default:
      return "Core Web Vitals data is unavailable for this scan.";
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function describeVerdict(verdict: ReadinessVerdict, mustFixCount: number, importantCount: number): { headline: string; summary: string } {
  if (verdict === "not_ready") {
    return {
      headline: "🔴 Your website isn't ready yet",
      summary: `We found ${plural(mustFixCount, "thing")} you must fix before launch.`,
    };
  }
  if (verdict === "almost_ready") {
    return {
      headline: "🟡 Your website is almost ready",
      summary: `We found ${plural(importantCount, "thing")} you should fix before launch.`,
    };
  }
  return {
    headline: "🟢 Your website looks ready to launch",
    summary: "We didn't find any launch-blocking problems in what we were able to check.",
  };
}
