import assert from "node:assert/strict";
import { test } from "node:test";
import { detectIssues, resetIssueIdCounter } from "../src/analysis/issues.js";
import type { FetchResult, HtmlAnalysis } from "../src/types.js";

function baseFetch(overrides: Partial<FetchResult> = {}): FetchResult {
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
    },
    bodyBytes: 5000,
    bodyText: "<html></html>",
    contentType: "text/html",
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

function baseHtml(overrides: Partial<HtmlAnalysis> = {}): HtmlAnalysis {
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
    ...overrides,
  };
}

test("a fully healthy page produces zero issues", () => {
  resetIssueIdCounter();
  const issues = detectIssues(baseFetch(), baseHtml());
  assert.equal(issues.length, 0);
});

test("missing title produces a critical SEO issue", () => {
  resetIssueIdCounter();
  const issues = detectIssues(baseFetch(), baseHtml({ title: null, titleLength: 0 }));
  const titleIssue = issues.find((i) => i.title.includes("title"));
  assert.ok(titleIssue);
  assert.equal(titleIssue!.severity, "critical");
  assert.equal(titleIssue!.category, "seo");
});

test("non-https site produces a critical security issue and skips HSTS check", () => {
  resetIssueIdCounter();
  const fetchResult = baseFetch({ httpsUsed: false, finalUrl: "http://example.com/", headers: {} });
  const issues = detectIssues(fetchResult, baseHtml());
  const httpsIssue = issues.find((i) => i.title.includes("HTTPS"));
  assert.ok(httpsIssue);
  assert.equal(httpsIssue!.severity, "critical");
  const hstsIssue = issues.find((i) => i.title.includes("HSTS"));
  assert.equal(hstsIssue, undefined, "HSTS should not be flagged on a non-HTTPS site");
});

test("slow TTFB produces a performance issue with the measured value as evidence", () => {
  resetIssueIdCounter();
  const issues = detectIssues(baseFetch({ timing: { approxTtfbMs: 2200, totalDownloadMs: 2300 } }), baseHtml());
  const slow = issues.find((i) => i.category === "performance" && i.severity === "critical");
  assert.ok(slow);
  assert.equal(slow!.evidence[0].value, "2200ms");
});

test("mixed content is only flagged on https pages", () => {
  resetIssueIdCounter();
  const issues = detectIssues(baseFetch(), baseHtml({ insecureResourceRefs: ["http://a.com/x.js"] }));
  const mixed = issues.find((i) => i.title.includes("Mixed content"));
  assert.ok(mixed);
  assert.equal(mixed!.category, "security");
});

test("every issue carries at least one piece of evidence", () => {
  resetIssueIdCounter();
  const issues = detectIssues(
    baseFetch({ headers: {}, httpsUsed: false, redirected: true, timing: { approxTtfbMs: 3000, totalDownloadMs: 3200 } }),
    baseHtml({ title: null, titleLength: 0, metaDescription: null, metaDescriptionLength: 0, h1Count: 0, canonicalUrl: null, hasViewportMeta: false, images: { total: 4, missingAlt: 4 } }),
  );
  assert.ok(issues.length > 5);
  for (const issue of issues) {
    assert.ok(issue.evidence.length > 0, `issue "${issue.title}" has no evidence`);
  }
});


test("flags an oversized HTML document", () => {
  resetIssueIdCounter();
  const issues = detectIssues(baseFetch({ bodyBytes: 200_000 }), baseHtml());
  const found = issues.find((i) => i.title === "HTML document is large");
  assert.ok(found);
  assert.equal(found?.severity, "medium");
  assert.equal(found?.category, "performance");
});

test("does not flag a normally-sized HTML document", () => {
  resetIssueIdCounter();
  const issues = detectIssues(baseFetch({ bodyBytes: 20_000 }), baseHtml());
  assert.ok(!issues.some((i) => i.title === "HTML document is large"));
  assert.ok(!issues.some((i) => i.title === "Empty HTML response"));
});

// ---------------- Empty HTML response (Session 11: a real "missing evidence read as good" gap) ----------------

test("REGRESSION: a 0-byte HTML response is flagged as critical, never silently treated as a lean/fast page", () => {
  resetIssueIdCounter();
  const issues = detectIssues(baseFetch({ bodyBytes: 0, bodyText: "", statusCode: 200 }), baseHtml());
  const found = issues.find((i) => i.title === "Empty HTML response");
  assert.ok(found);
  assert.equal(found?.severity, "critical");
  assert.equal(found?.category, "performance");
  assert.ok(found!.whyItMatters.includes("NOT a lightweight"));
});

test("empty-HTML and large-HTML are mutually exclusive (never both fire for the same page)", () => {
  resetIssueIdCounter();
  const emptyIssues = detectIssues(baseFetch({ bodyBytes: 0 }), baseHtml());
  assert.ok(!emptyIssues.some((i) => i.title === "HTML document is large"));
});

test("does not flag a small but non-empty HTML document as empty", () => {
  resetIssueIdCounter();
  const issues = detectIssues(baseFetch({ bodyBytes: 300 }), baseHtml());
  assert.ok(!issues.some((i) => i.title === "Empty HTML response"));
});
