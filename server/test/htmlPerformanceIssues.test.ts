import assert from "node:assert/strict";
import { test } from "node:test";
import { detectHtmlPerformanceIssues, resetHtmlPerformanceIssueIdCounter } from "../src/analysis/htmlPerformanceIssues.js";
import type { HtmlAnalysis, HtmlResourceIntel } from "../src/types.js";

const URL = "https://example.com/";

function emptyIntel(): HtmlResourceIntel {
  return {
    resourceHints: { preload: 0, preloadMissingAs: 0, prefetch: 0, preconnect: 0, dnsPrefetch: 0, modulepreload: 0 },
    images: { missingDimensions: 0, missingDimensionsExamples: [], eagerLikelyBelowFold: 0, eagerLikelyBelowFoldExamples: [] },
    scripts: { duplicateSrcCount: 0, duplicateSrcExamples: [], inlineScriptBytes: 0, devOrLocalhostRefs: [], sourceMapRefs: [] },
    stylesheets: { duplicateHrefCount: 0, duplicateHrefExamples: [], inlineStyleBytes: 0 },
    fonts: { linkCount: 0, families: [] },
    media: { videoCount: 0, audioCount: 0, iframeCount: 0 },
    libraryHints: [],
  };
}

function baseHtml(resourceIntel: HtmlResourceIntel): HtmlAnalysis {
  return {
    title: "A title",
    titleLength: 7,
    titleCount: 1,
    metaDescription: null,
    metaDescriptionLength: 0,
    metaDescriptionCount: 0,
    h1Count: 1,
    h1Texts: ["x"],
    rawH1Count: 1,
    canonicalUrl: null,
    canonicalCount: 0,
    canonicalEmpty: false,
    robotsMeta: null,
    robotsMetaCount: 0,
    robotsMetaValues: [],
    hasViewportMeta: true,
    hasCharsetMeta: true,
    images: { total: 0, missingAlt: 0 },
    scripts: { total: 0, blockingInHead: 0, asyncOrDefer: 0 },
    stylesheets: { total: 0, blockingInHead: 0 },
    insecureResourceRefs: [],
    resourceIntel,
  };
}

test("HtmlAnalysis without resourceIntel (older/hand-built fixture) produces no issues, never throws", () => {
  resetHtmlPerformanceIssueIdCounter();
  const html = { ...baseHtml(emptyIntel()), resourceIntel: undefined };
  assert.deepEqual(detectHtmlPerformanceIssues(html, URL), []);
});

test("all-empty resourceIntel produces no issues", () => {
  resetHtmlPerformanceIssueIdCounter();
  assert.deepEqual(detectHtmlPerformanceIssues(baseHtml(emptyIntel()), URL), []);
});

test("images missing width/height are flagged, with severity scaling by count", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.images.missingDimensions = 2;
  intel.images.missingDimensionsExamples = ["/a.jpg", "/b.jpg"];
  const issues = detectHtmlPerformanceIssues(baseHtml(intel), URL);
  const issue = issues.find((i) => i.title === "Images missing explicit width/height");
  assert.ok(issue);
  assert.equal(issue!.severity, "medium");
  assert.equal(issue!.evidence.length, 2);

  resetHtmlPerformanceIssueIdCounter();
  intel.images.missingDimensions = 6;
  const highIssue = detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title === "Images missing explicit width/height");
  assert.equal(highIssue!.severity, "high");
});

test("localhost/dev resource references are always critical", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.scripts.devOrLocalhostRefs = ["http://localhost:5173/app.js"];
  const issue = detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title.includes("localhost"));
  assert.ok(issue);
  assert.equal(issue!.severity, "critical");
  assert.equal(issue!.evidence[0].value, "http://localhost:5173/app.js");
});

test("exposed source maps are flagged", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.scripts.sourceMapRefs = ["/app.js.map"];
  const issue = detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title.includes("Source map"));
  assert.ok(issue);
  assert.equal(issue!.severity, "medium");
});

test("duplicate script and stylesheet references are flagged with different severities", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.scripts.duplicateSrcCount = 1;
  intel.scripts.duplicateSrcExamples = ["/vendor.js"];
  intel.stylesheets.duplicateHrefCount = 1;
  intel.stylesheets.duplicateHrefExamples = ["/main.css"];
  const issues = detectHtmlPerformanceIssues(baseHtml(intel), URL);
  const scriptIssue = issues.find((i) => i.title.includes("script is referenced"));
  const cssIssue = issues.find((i) => i.title.includes("stylesheet is referenced"));
  assert.equal(scriptIssue!.severity, "medium");
  assert.equal(cssIssue!.severity, "low");
});

test("large inline script payload is flagged, more severely above the higher threshold", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.scripts.inlineScriptBytes = 60_000;
  const medium = detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title.includes("inline JavaScript"));
  assert.equal(medium!.severity, "medium");

  resetHtmlPerformanceIssueIdCounter();
  intel.scripts.inlineScriptBytes = 200_000;
  const high = detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title.includes("inline JavaScript"));
  assert.equal(high!.severity, "high");
});

test("small inline script payload is not flagged", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.scripts.inlineScriptBytes = 500;
  assert.equal(detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title.includes("inline JavaScript")), undefined);
});

test("preload missing as= is flagged", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.resourceHints.preload = 3;
  intel.resourceHints.preloadMissingAs = 2;
  const issue = detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title.includes("without an"));
  assert.ok(issue);
  assert.equal(issue!.severity, "low");
});

test("excessive combined preconnect/dns-prefetch hints are flagged", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.resourceHints.preconnect = 5;
  intel.resourceHints.dnsPrefetch = 4;
  const issue = detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title === "Excessive preconnect/dns-prefetch hints");
  assert.ok(issue);
});

test("a modest number of resource hints is not flagged", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.resourceHints.preconnect = 2;
  intel.resourceHints.dnsPrefetch = 1;
  assert.equal(detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title === "Excessive preconnect/dns-prefetch hints"), undefined);
});

test("excessive font variants for one family are flagged with the font URL as evidence", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.fonts.families = [{ href: "https://fonts.googleapis.com/css2?family=Roboto:wght@100;200;300;400;500;600;700", variantCount: 7 }];
  const issue = detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title.includes("font weights"));
  assert.ok(issue);
  assert.equal(issue!.evidence[0].value, intel.fonts.families[0].href);
});

test("a reasonable font variant count is not flagged", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.fonts.families = [{ href: "https://fonts.googleapis.com/css2?family=Roboto:wght@400;700", variantCount: 2 }];
  assert.equal(detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title.includes("font weights")), undefined);
});

test("two distinct icon libraries are flagged as a duplicate-library-purpose issue", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.libraryHints = [
    { keyword: "font-awesome", src: "/font-awesome.min.css" },
    { keyword: "material-icons", src: "/material-icons.css" },
  ];
  const issue = detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title.includes("icon library libraries") || i.title.includes("icon library"));
  assert.ok(issue);
});

test("a single icon library alone is not flagged as a duplicate", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.libraryHints = [{ keyword: "font-awesome", src: "/font-awesome.min.css" }];
  const issue = detectHtmlPerformanceIssues(baseHtml(intel), URL).find((i) => i.title.includes("icon library"));
  assert.equal(issue, undefined);
});

test("every HTML-derived finding carries an affected URL and at least one evidence item", () => {
  resetHtmlPerformanceIssueIdCounter();
  const intel = emptyIntel();
  intel.images.missingDimensions = 1;
  intel.images.missingDimensionsExamples = ["/a.jpg"];
  intel.scripts.devOrLocalhostRefs = ["http://localhost:3000/x.js"];
  const issues = detectHtmlPerformanceIssues(baseHtml(intel), URL);
  assert.ok(issues.length > 0);
  for (const issue of issues) {
    assert.equal(issue.affected, URL);
    assert.equal(issue.category, "performance");
    assert.equal(issue.source, "measured");
    assert.ok(issue.evidence.length > 0);
  }
});
