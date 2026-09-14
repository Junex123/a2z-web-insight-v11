import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { collectHtml } from "../src/collectors/htmlCollector.js";
import { collectSeoExtras } from "../src/collectors/seoCollector.js";
import { parseRobotsTxt } from "../src/collectors/robotsCollector.js";
import { detectAdvancedSeoIssues, resetSeoIssueIdCounter } from "../src/analysis/seoIssues.js";

const PAGE_URL = "https://example.com/page";

function analyze(html: string, headers: Record<string, string> = {}, robotsRaw: string | null = null) {
  const fetchResult = { finalUrl: PAGE_URL, statusCode: 200 };
  const htmlAnalysis = collectHtml(html, true);
  const seo = collectSeoExtras(html, PAGE_URL, headers);
  const robots = robotsRaw ? parseRobotsTxt(robotsRaw) : null;
  return detectAdvancedSeoIssues(fetchResult, htmlAnalysis, seo, robots);
}

beforeEach(() => resetSeoIssueIdCounter());

test("a genuinely clean, well-optimized page produces no advanced SEO issues", () => {
  const html = `<html><head>
    <title>A Well Optimized Page - Example Site</title>
    <meta name="description" content="A clean, complete, well-optimized example page used to verify no false positives are produced.">
    <link rel="canonical" href="https://example.com/page">
    <meta property="og:title" content="A Well Optimized Page">
    <meta property="og:description" content="A clean example page.">
    <meta property="og:image" content="https://example.com/og.png">
  </head><body>
    <h1>A Well Optimized Page</h1>
    <p>${"This page has plenty of real, descriptive content about the subject matter. ".repeat(10)}</p>
    <img src="/hero.png" alt="Descriptive hero" width="800" height="400">
    <a href="/related-page">Read a related page</a>
  </body></html>`;
  const issues = analyze(html);
  assert.deepEqual(issues, []);
});

test("flags conflicting indexability signals between meta robots and X-Robots-Tag", () => {
  const html = `<html><head><meta name="robots" content="index, follow"></head></html>`;
  const issues = analyze(html, { "x-robots-tag": "noindex" });
  assert.ok(issues.some((i) => i.title.includes("Conflicting indexability")));
});

test("flags a malformed canonical URL", () => {
  const html = `<html><head><link rel="canonical" href="http://"></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Canonical URL is malformed")));
});

test("flags a canonical pointing to a different domain", () => {
  const html = `<html><head><link rel="canonical" href="https://other-site.example/page"></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("different domain")));
});

test("flags a relative canonical URL as a low-severity finding", () => {
  const html = `<html><head><link rel="canonical" href="/page"></head></html>`;
  const issues = analyze(html);
  const found = issues.find((i) => i.title.includes("relative"));
  assert.ok(found);
  assert.equal(found?.severity, "low");
});

test("flags multiple canonical declarations", () => {
  const html = `<html><head><link rel="canonical" href="/a"><link rel="canonical" href="/b"></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Multiple canonical")));
});

test("flags an important page blocked by robots.txt (high severity, since it's otherwise indexable)", () => {
  const html = `<html><head><title>Products</title></head></html>`;
  const robotsRaw = `User-agent: *\nDisallow: /page`;
  const issues = analyze(html, {}, robotsRaw);
  const found = issues.find((i) => i.title.includes("blocked by robots.txt"));
  assert.ok(found);
  assert.equal(found?.severity, "high");
});

test("does not flag robots.txt blocking when the path is not disallowed", () => {
  const html = `<html><head><title>Products</title></head></html>`;
  const robotsRaw = `User-agent: *\nDisallow: /admin/`;
  const issues = analyze(html, {}, robotsRaw);
  assert.ok(!issues.some((i) => i.title.includes("blocked by robots.txt")));
});

test("flags malformed JSON-LD", () => {
  const html = `<html><head><script type="application/ld+json">{ not valid json </script></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Malformed JSON-LD")));
});

test("does not flag valid, complete JSON-LD", () => {
  const html = `<html><head><script type="application/ld+json">{"@type":"Organization","name":"Acme","url":"https://example.com"}</script></head></html>`;
  const issues = analyze(html);
  assert.ok(!issues.some((i) => i.title.includes("JSON-LD")));
});

test("flags structured data missing required properties", () => {
  const html = `<html><head><script type="application/ld+json">{"@type":"Product"}</script></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("missing recommended properties")));
});

test("flags structured data that mismatches visible page content", () => {
  const html = `<html><head><title>Widget</title>
    <script type="application/ld+json">{"@type":"Product","name":"Widget","offers":{"price":"100","priceCurrency":"USD"}}</script>
  </head><body><h1>Widget</h1><p>On sale now for $999.</p></body></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("doesn't match visible page content")));
});

test("flags incomplete Open Graph metadata when some OG tags are present", () => {
  const html = `<html><head><meta property="og:title" content="Hi"></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Incomplete Open Graph")));
});

test("does not flag Open Graph metadata when none is present at all", () => {
  const html = `<html><head><title>No OG here</title></head></html>`;
  const issues = analyze(html);
  assert.ok(!issues.some((i) => i.title.includes("Open Graph")));
});

test("flags malformed hreflang language codes", () => {
  const html = `<html><head><link rel="alternate" hreflang="zzzzzz" href="/x"></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Malformed hreflang")));
});

test("flags a hreflang set with no self-reference", () => {
  const html = `<html><head><link rel="alternate" hreflang="fr" href="https://example.com/fr"></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("no self-referencing entry")));
});

test("flags a thin-content page", () => {
  const html = `<html><body><p>Hi.</p></body></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Very little visible text")));
});

test("flags a placeholder page as high severity, distinct from generic thin content", () => {
  const html = `<html><body><h1>Coming soon</h1><p>We are working on this page.</p></body></html>`;
  const issues = analyze(html);
  const found = issues.find((i) => i.title.includes("placeholder"));
  assert.ok(found);
  assert.equal(found?.severity, "high");
  assert.ok(!issues.some((i) => i.title.includes("Very little visible text")));
});

test("flags images missing width/height dimensions", () => {
  const html = `<html><body><img src="/a.png" alt="a"><p>${"padding text ".repeat(30)}</p></body></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("missing width/height")));
});

test("flags a substantial page with zero internal links", () => {
  const html = `<html><body><p>${"Real content with no links anywhere on the page at all. ".repeat(10)}</p></body></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("no internal links")));
});

test("does not flag a very short page for having zero internal links (thin content owns that case instead)", () => {
  const html = `<html><body><p>Hi.</p></body></html>`;
  const issues = analyze(html);
  assert.ok(!issues.some((i) => i.title.includes("no internal links")));
});

test("does not flag a page that has at least one internal link", () => {
  const html = `<html><body><p>${"Real content with a link somewhere on the page. ".repeat(10)}</p><a href="/other">Other page</a></body></html>`;
  const issues = analyze(html);
  assert.ok(!issues.some((i) => i.title.includes("no internal links")));
});

// ---------------- anchor text quality ----------------

test("flags a pattern of generic anchor text on internal links", () => {
  const html = `<html><body>
    <a href="/a">Click here</a>
    <a href="/b">Read more</a>
    <a href="/c">here</a>
  </body></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("generic, non-descriptive anchor text")));
});

test("does not flag one or two isolated generic-anchor-text links", () => {
  const html = `<html><body><a href="/a">Click here</a><a href="/b">Read more</a></body></html>`;
  const issues = analyze(html);
  assert.ok(!issues.some((i) => i.title.includes("generic, non-descriptive anchor text")));
});

test("does not flag descriptive anchor text", () => {
  const html = `<html><body>
    <a href="/a">Our return policy</a>
    <a href="/b">Shipping options</a>
    <a href="/c">Contact support</a>
  </body></html>`;
  const issues = analyze(html);
  assert.ok(!issues.some((i) => i.title.includes("generic, non-descriptive anchor text")));
});

// ---------------- pagination ----------------

test("flags a malformed rel=next pagination link", () => {
  const html = `<html><head><link rel="next" href="http://"></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes('Malformed rel="next"')));
});

test("flags a rel=next link that points at itself", () => {
  const html = `<html><head><link rel="next" href="https://example.com/page"></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes('points at this same page')));
});

test("does not flag a normal, well-formed rel=next/prev pair", () => {
  const html = `<html><head><link rel="next" href="https://example.com/page-3"><link rel="prev" href="https://example.com/page-1"></head></html>`;
  const issues = analyze(html);
  assert.ok(!issues.some((i) => i.title.toLowerCase().includes("pagination") || i.title.includes('rel="next"') || i.title.includes('rel="prev"')));
});

test("does not require pagination on a page that has none (normal, not a gap)", () => {
  const html = `<html><head><title>Regular page</title></head></html>`;
  const issues = analyze(html);
  assert.ok(!issues.some((i) => i.title.toLowerCase().includes("pagination")));
});

// ---------------- structured-data entity conflicts ----------------

test("flags two Organization blocks disagreeing on name", () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"Organization","name":"Acme Inc","url":"https://example.com"}</script>
    <script type="application/ld+json">{"@type":"Organization","name":"Acme Corporation","url":"https://example.com"}</script>
  </head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Conflicting Organization structured data")));
});

test("does not flag two Organization blocks that agree on name", () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"Organization","name":"Acme Inc","url":"https://example.com"}</script>
    <script type="application/ld+json">{"@type":"Organization","name":"Acme Inc","url":"https://example.com/about"}</script>
  </head></html>`;
  const issues = analyze(html);
  assert.ok(!issues.some((i) => i.title.includes("Conflicting Organization")));
});

test("does not flag two different Product blocks with different names (that's not a conflict)", () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"Product","name":"Widget A"}</script>
    <script type="application/ld+json">{"@type":"Product","name":"Widget B"}</script>
  </head></html>`;
  const issues = analyze(html);
  assert.ok(!issues.some((i) => i.title.includes("Conflicting")));
});

test("every emitted issue carries evidence, a fix, and an explanation", () => {
  const html = `<html><head><link rel="canonical" href="https://other.example/x"></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.length > 0);
  for (const issue of issues) {
    assert.ok(issue.evidence.length > 0);
    assert.ok(issue.recommendedFix.length > 0);
    assert.ok(issue.whyItMatters.length > 0);
    assert.equal(issue.category, "seo");
  }
});
