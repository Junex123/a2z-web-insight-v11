import type { RuntimeFinding, RuntimeVerificationEvidence, Severity } from "../types.js";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `runtime-${counter}`;
}
export function resetRuntimeFindingIdCounter() {
  counter = 0;
}

function makeFinding(input: Omit<RuntimeFinding, "id">): RuntimeFinding {
  return { ...input, id: nextId() };
}

/** resource types where a first-party failure is likely to break core functionality, not just a visual nicety */
const CRITICAL_RESOURCE_TYPES = new Set(["document", "xhr", "fetch"]);
const MAX_EVIDENCE_EXAMPLES = 5;

/**
 * Deterministic, evidence-backed rules against the facts collectRuntime()
 * already gathered - this function does not touch the browser/DOM
 * itself, matching the MEASURE/ANALYZE split used throughout this
 * project (issues.ts, cwvIssues.ts, accessibilityIssues.ts).
 *
 * DELIBERATE NON-DUPLICATION / RESTRAINT, matching this feature's brief:
 *   - Third-party request failures are NEVER turned into a finding here,
 *     regardless of how many there are - only surfaced in the raw
 *     evidence (`requests[].isFirstParty === false`). A broken
 *     analytics/ad/social embed is extremely common and not something
 *     the site itself controls; scoring it would create noise and false
 *     alarm ("Do not treat every third-party failure as critical").
 *   - console.warn / non-error console output is NEVER turned into a
 *     finding, only surfaced in evidence.consoleMessages - the brief is
 *     explicit that not every warning should become a finding, and
 *     warnings are common/noisy in real-world sites without indicating
 *     an actual problem.
 *   - "likely JS-dependent content" (evidence.contentComparison) is
 *     informational ONLY, never itself a finding - a site that renders
 *     real content via JavaScript successfully is working correctly.
 *     It only becomes a problem when combined with an actually blank
 *     render or an actual JS error, both of which have their own rules
 *     below.
 */
export function detectRuntimeFindings(evidence: RuntimeVerificationEvidence): RuntimeFinding[] {
  const findings: RuntimeFinding[] = [];
  const affected = evidence.finalUrl;

  // ---------------- uncaught JavaScript exceptions ----------------
  const uncaught = evidence.jsErrors.filter((e) => e.source === "pageerror");
  if (uncaught.length > 0) {
    findings.push(
      makeFinding({
        severity: "critical",
        title: "Uncaught JavaScript error during page load",
        affected,
        whyItMatters:
          "An uncaught exception can halt further script execution, breaking interactive features or any content that depends on JavaScript finishing successfully.",
        estimatedImpact: `${uncaught.length} uncaught error(s) detected. First: "${uncaught[0].message}"`,
        recommendedFix: "Reproduce the error in a browser's devtools console and add error handling or fix the underlying bug.",
        difficulty: "moderate",
        source: "measured",
        evidence: uncaught
          .slice(0, MAX_EVIDENCE_EXAMPLES)
          .map((e) => ({ type: "computed" as const, label: "Uncaught JS error", value: e.message })),
      }),
    );
  }

  // ---------------- console.error output ----------------
  const consoleErrors = evidence.consoleMessages.filter((m) => m.level === "error");
  if (consoleErrors.length > 0) {
    findings.push(
      makeFinding({
        severity: "medium",
        title: "Console errors logged during page load",
        affected,
        whyItMatters:
          "console.error output often indicates a caught-but-unhandled problem (a failed API call, a broken integration) that doesn't crash the page but may mean a feature is silently not working.",
        estimatedImpact: `${consoleErrors.length} console.error message(s). First: "${consoleErrors[0].text}"`,
        recommendedFix: "Review the console output in devtools and address the underlying cause of each error.",
        difficulty: "moderate",
        source: "measured",
        evidence: consoleErrors
          .slice(0, MAX_EVIDENCE_EXAMPLES)
          .map((m) => ({ type: "computed" as const, label: "console.error", value: m.text })),
      }),
    );
  }

  // ---------------- failed first-party requests ----------------
  const failedFirstParty = evidence.requests.filter((r) => r.isFirstParty && r.outcome === "failed");
  if (failedFirstParty.length > 0) {
    const hasCritical = failedFirstParty.some((r) => CRITICAL_RESOURCE_TYPES.has(r.resourceType));
    const severity: Severity = hasCritical ? "critical" : "high";
    findings.push(
      makeFinding({
        severity,
        title: "First-party requests failed during page load",
        affected,
        whyItMatters:
          "A failed request to your own site's resources (script, stylesheet, API call, or the page itself) can break functionality or layout for every visitor, not just an unlucky few.",
        estimatedImpact: `${failedFirstParty.length} first-party request(s) failed, e.g. ${failedFirstParty
          .slice(0, 3)
          .map((r) => `${r.resourceType} ${r.url}`)
          .join(", ")}.`,
        recommendedFix: "Check that these first-party resources exist, are deployed correctly, and that the server returns a successful response for them.",
        difficulty: "moderate",
        source: "measured",
        evidence: failedFirstParty
          .slice(0, MAX_EVIDENCE_EXAMPLES)
          .map((r) => ({ type: "computed" as const, label: `Failed ${r.resourceType} request`, value: `${r.url} (${r.failureReason ?? "no response"})` })),
      }),
    );
  }

  // ---------------- blank rendered page ----------------
  if (!evidence.domSnapshot.hasBodyContent) {
    findings.push(
      makeFinding({
        severity: "critical",
        title: "Page renders blank after JavaScript execution",
        affected,
        whyItMatters:
          "Visitors (and any search engine that renders JavaScript) see an effectively empty page - this usually means a JavaScript framework failed to mount or crashed before rendering any content.",
        estimatedImpact: `Rendered visible text length: ${evidence.domSnapshot.visibleTextLength} character(s), ${evidence.domSnapshot.elementCount} element(s) in the DOM.`,
        recommendedFix: "Check the JavaScript error and failed-request findings above for the root cause, and verify the page's root/mount element is actually being populated.",
        difficulty: "hard",
        source: "measured",
        evidence: [{ type: "computed", label: "Rendered visible text length", value: `${evidence.domSnapshot.visibleTextLength} chars` }],
      }),
    );
  }

  // ---------------- navigation resolved but with an error response ----------------
  if (!evidence.navigationOk) {
    findings.push(
      makeFinding({
        severity: "high",
        title: "Page did not load successfully in a real browser",
        affected,
        whyItMatters: "The browser reached the server but received an error response, which real visitors would also see.",
        estimatedImpact: evidence.httpStatus !== null ? `Browser-observed HTTP status: ${evidence.httpStatus}.` : "No response status was observed.",
        recommendedFix: "Investigate why the server returned an error response for this URL when rendered in a browser.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "computed", label: "Browser-observed HTTP status", value: String(evidence.httpStatus ?? "unknown") }],
      }),
    );
  }

  // ---------------- insecure form action (mixed-content downgrade) ----------------
  const insecureForms = evidence.forms.filter((f) => f.actionIsInsecureHttp);
  if (insecureForms.length > 0) {
    findings.push(
      makeFinding({
        severity: "high",
        title: "Form submits to an insecure http:// URL from an https page",
        affected,
        whyItMatters:
          "Submitting form data (which may include passwords or personal information) to a plain http:// endpoint from an https page exposes it to interception, and browsers may block or warn on the submission.",
        estimatedImpact: `${insecureForms.length} form(s) affected, e.g. ${insecureForms.slice(0, 3).map((f) => f.action).join(", ")}.`,
        recommendedFix: "Change the form's action attribute to use https://, or make it a relative URL so it inherits the page's scheme.",
        difficulty: "easy",
        source: "measured",
        evidence: insecureForms
          .slice(0, MAX_EVIDENCE_EXAMPLES)
          .map((f) => ({ type: "html" as const, label: "Insecure form action", value: f.action ?? "" })),
      }),
    );
  }

  return findings;
}
