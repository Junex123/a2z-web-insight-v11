import assert from "node:assert/strict";
import { test } from "node:test";
import { detectIssues, resetIssueIdCounter } from "../src/analysis/issues.js";
import type { FetchResult, HtmlAnalysis } from "../src/types.js";

function baseFetch(headerOverrides: Record<string, string> = {}, overrides: Partial<FetchResult> = {}): FetchResult {
  return {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    statusCode: 200,
    httpsUsed: true,
    redirected: false,
    redirectCount: 0,
    timing: { approxTtfbMs: 150, totalDownloadMs: 200 },
    headers: {
      "content-encoding": "gzip",
      "cache-control": "public, max-age=3600",
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "content-security-policy": "default-src 'self'",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      ...headerOverrides,
    },
    bodyBytes: 5000,
    bodyText: "<html></html>",
    contentType: "text/html",
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

function baseHtml(): HtmlAnalysis {
  return {
    title: "A Good Title That Is Reasonably Descriptive",
    titleLength: 45,
    metaDescription: "A meta description that is a healthy, reasonable length for search snippets to display fully.",
    metaDescriptionLength: 100,
    h1Count: 1,
    h1Texts: ["Main heading"],
    canonicalUrl: "https://example.com/",
    robotsMeta: null,
    hasViewportMeta: true,
    hasCharsetMeta: true,
    images: { total: 2, missingAlt: 0 },
    scripts: { total: 1, blockingInHead: 0, asyncOrDefer: 1 },
    stylesheets: { total: 1, blockingInHead: 1 },
    insecureResourceRefs: [],
  };
}

function securityIssues(headerOverrides: Record<string, string> = {}) {
  resetIssueIdCounter();
  return detectIssues(baseFetch(headerOverrides), baseHtml()).filter((i) => i.category === "security");
}

// ---------------- regression: the fully-healthy fixture still produces zero security issues ----------------

test("a fully healthy header set (including permissions-policy) produces zero security issues", () => {
  assert.deepEqual(securityIssues(), []);
});

// ---------------- CSP quality ----------------

test("CSP with 'unsafe-inline' in script-src is flagged as weakening, at medium severity", () => {
  const issues = securityIssues({ "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'" });
  const issue = issues.find((i) => i.title === "Content-Security-Policy contains weakening directives");
  assert.ok(issue);
  assert.equal(issue!.severity, "medium");
  assert.ok(issue!.estimatedImpact!.includes("unsafe-inline"));
});

test("CSP with 'unsafe-eval' is flagged", () => {
  const issues = securityIssues({ "content-security-policy": "script-src 'self' 'unsafe-eval'" });
  const issue = issues.find((i) => i.title === "Content-Security-Policy contains weakening directives");
  assert.ok(issue);
  assert.ok(issue!.estimatedImpact!.includes("unsafe-eval"));
});

test("CSP with a bare wildcard script source is flagged", () => {
  const issues = securityIssues({ "content-security-policy": "script-src *" });
  const issue = issues.find((i) => i.title === "Content-Security-Policy contains weakening directives");
  assert.ok(issue);
  assert.ok(issue!.estimatedImpact!.includes("wildcard"));
});

test("CSP falls back to default-src when script-src isn't set", () => {
  const issues = securityIssues({ "content-security-policy": "default-src 'unsafe-inline'" });
  const issue = issues.find((i) => i.title === "Content-Security-Policy contains weakening directives");
  assert.ok(issue);
  assert.ok(issue!.estimatedImpact!.includes("default-src"));
});

test("a strong CSP ('self' only, no unsafe-inline/unsafe-eval/wildcard) is never flagged as weak", () => {
  const issues = securityIssues({ "content-security-policy": "default-src 'self'; script-src 'self'; object-src 'none'" });
  assert.equal(issues.find((i) => i.title === "Content-Security-Policy contains weakening directives"), undefined);
});

test("an unfamiliar directive alone is never flagged - only the specific documented weaknesses are checked", () => {
  const issues = securityIssues({ "content-security-policy": "script-src 'self'; upgrade-insecure-requests; some-future-directive value" });
  assert.equal(issues.find((i) => i.title === "Content-Security-Policy contains weakening directives"), undefined);
});

test("regression: CSP missing entirely still produces the existing 'No Content-Security-Policy header' finding", () => {
  const fetchResult = baseFetch();
  delete fetchResult.headers["content-security-policy"];
  resetIssueIdCounter();
  const issues = detectIssues(fetchResult, baseHtml()).filter((i) => i.category === "security");
  assert.ok(issues.some((i) => i.title === "No Content-Security-Policy header"));
  // and the weak-CSP finding never fires when there's no CSP to analyze
  assert.equal(issues.find((i) => i.title === "Content-Security-Policy contains weakening directives"), undefined);
});

// ---------------- X-Content-Type-Options value ----------------

test("X-Content-Type-Options present with a wrong value is flagged as ineffective, medium severity", () => {
  const issues = securityIssues({ "x-content-type-options": "sniff" });
  const issue = issues.find((i) => i.title === "X-Content-Type-Options header has an ineffective value");
  assert.ok(issue);
  assert.equal(issue!.severity, "medium");
  assert.ok(issue!.estimatedImpact!.includes("sniff"));
});

test("X-Content-Type-Options value check is case-insensitive - 'NoSniff' is accepted", () => {
  const issues = securityIssues({ "x-content-type-options": "NoSniff" });
  assert.equal(issues.find((i) => i.title.includes("X-Content-Type-Options")), undefined);
});

test("regression: X-Content-Type-Options missing entirely still produces the existing finding", () => {
  const fetchResult = baseFetch();
  delete fetchResult.headers["x-content-type-options"];
  resetIssueIdCounter();
  const issues = detectIssues(fetchResult, baseHtml()).filter((i) => i.category === "security");
  assert.ok(issues.some((i) => i.title === "Missing X-Content-Type-Options header"));
});

// ---------------- Clickjacking (X-Frame-Options / frame-ancestors) ----------------

test("an invalid X-Frame-Options value (legacy ALLOW-FROM) with no frame-ancestors is treated as unprotected, with accurate evidence", () => {
  const issues = securityIssues({ "x-frame-options": "ALLOW-FROM https://example.com", "content-security-policy": "default-src 'self'" });
  const issue = issues.find((i) => i.title === "No clickjacking protection (X-Frame-Options / frame-ancestors)");
  assert.ok(issue);
  assert.ok(issue!.evidence[0].value.includes("ALLOW-FROM"));
});

test("X-Frame-Options: DENY is valid protection", () => {
  const issues = securityIssues({ "x-frame-options": "DENY" });
  assert.equal(issues.find((i) => i.title.includes("clickjacking")), undefined);
});

test("a missing X-Frame-Options but a restrictive CSP frame-ancestors provides protection - no finding", () => {
  const fetchResult = baseFetch({ "content-security-policy": "frame-ancestors 'self'" });
  delete fetchResult.headers["x-frame-options"];
  resetIssueIdCounter();
  const found = detectIssues(fetchResult, baseHtml()).filter((i) => i.category === "security");
  assert.equal(found.find((i) => i.title.includes("clickjacking")), undefined);
});

test("a wildcard CSP frame-ancestors provides NO protection and is flagged, with evidence naming the wildcard", () => {
  const fetchResult = baseFetch({ "content-security-policy": "frame-ancestors *" });
  delete fetchResult.headers["x-frame-options"];
  resetIssueIdCounter();
  const issues = detectIssues(fetchResult, baseHtml()).filter((i) => i.category === "security");
  const issue = issues.find((i) => i.title.includes("clickjacking"));
  assert.ok(issue);
  assert.ok(issue!.evidence[0].value.toLowerCase().includes("wildcard"));
});

test("invalid X-Frame-Options AND wildcard frame-ancestors together still produce exactly ONE clickjacking finding, never two", () => {
  const issues = securityIssues({ "x-frame-options": "GARBAGE", "content-security-policy": "frame-ancestors *" });
  const matches = issues.filter((i) => i.title.includes("clickjacking"));
  assert.equal(matches.length, 1);
});

// ---------------- Referrer-Policy value ----------------

test("Referrer-Policy: unsafe-url is flagged as weak, low severity, distinct from the missing-header finding", () => {
  const issues = securityIssues({ "referrer-policy": "unsafe-url" });
  const issue = issues.find((i) => i.title === "Referrer-Policy is set to a weak value");
  assert.ok(issue);
  assert.equal(issue!.severity, "low");
  assert.equal(issues.find((i) => i.title === "No Referrer-Policy header"), undefined);
});

test("regression: Referrer-Policy missing entirely still produces the existing finding, not the weak-value one", () => {
  const fetchResult = baseFetch();
  delete fetchResult.headers["referrer-policy"];
  resetIssueIdCounter();
  const issues = detectIssues(fetchResult, baseHtml()).filter((i) => i.category === "security");
  assert.ok(issues.some((i) => i.title === "No Referrer-Policy header"));
  assert.equal(issues.find((i) => i.title === "Referrer-Policy is set to a weak value"), undefined);
});

test("a moderate Referrer-Policy value (e.g. 'origin') is not flagged as weak - only the genuinely unsafe values are", () => {
  const issues = securityIssues({ "referrer-policy": "origin" });
  assert.equal(issues.find((i) => i.title === "Referrer-Policy is set to a weak value"), undefined);
});

// ---------------- Permissions-Policy ----------------

test("missing Permissions-Policy is flagged at low severity", () => {
  const fetchResult = baseFetch();
  delete fetchResult.headers["permissions-policy"];
  resetIssueIdCounter();
  const issues = detectIssues(fetchResult, baseHtml()).filter((i) => i.category === "security");
  const issue = issues.find((i) => i.title === "No Permissions-Policy header");
  assert.ok(issue);
  assert.equal(issue!.severity, "low");
});

test("a present Permissions-Policy produces no finding regardless of its specific value", () => {
  const issues = securityIssues({ "permissions-policy": "geolocation=(self)" });
  assert.equal(issues.find((i) => i.title.includes("Permissions-Policy")), undefined);
});

// ---------------- every new/changed finding still carries full evidence ----------------

test("every security finding this session touched still carries category, severity, evidence, and a concrete recommendation", () => {
  const issues = securityIssues({
    "x-content-type-options": "sniff",
    "content-security-policy": "script-src 'unsafe-inline' 'unsafe-eval' *",
    "referrer-policy": "unsafe-url",
  });
  assert.ok(issues.length > 0);
  for (const issue of issues) {
    assert.equal(issue.category, "security");
    assert.ok(issue.evidence.length > 0);
    assert.notEqual(issue.recommendedFix.trim().toLowerCase(), "security could be improved.");
    assert.equal(issue.source, "measured");
  }
});
