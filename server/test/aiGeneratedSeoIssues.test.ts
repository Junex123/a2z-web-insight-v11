import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { collectHtml } from "../src/collectors/htmlCollector.js";
import { collectSeoExtras } from "../src/collectors/seoCollector.js";
import { parseRobotsTxt } from "../src/collectors/robotsCollector.js";
import { detectAiGeneratedSeoFailures, resetAiGeneratedSeoIssueIdCounter } from "../src/analysis/aiGeneratedSeoIssues.js";
import type { SitemapAnalysis } from "../src/types.js";

const PAGE_URL = "https://example.com/page";

function analyze(html: string, robotsRaw: string | null = null, sitemap: SitemapAnalysis | null = null) {
  const fetchResult = { finalUrl: PAGE_URL };
  const htmlAnalysis = collectHtml(html, true);
  const seo = collectSeoExtras(html, PAGE_URL, {});
  const robots = robotsRaw ? parseRobotsTxt(robotsRaw) : null;
  return detectAiGeneratedSeoFailures(fetchResult, htmlAnalysis, seo, robots, sitemap);
}

beforeEach(() => resetAiGeneratedSeoIssueIdCounter());

test("does not flag a real, specific title/description", () => {
  const html = `<html><head><title>Handmade Ceramic Mugs - Riverside Pottery</title><meta name="description" content="Shop handmade ceramic mugs, thrown and glazed in our Riverside studio."></head><body></body></html>`;
  const issues = analyze(html);
  assert.deepEqual(issues, []);
});

test('flags a generic "Home | Website" title', () => {
  const html = `<html><head><title>Home | Website</title></head><body></body></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Generic placeholder page title")));
});

test("flags an Untitled Document title", () => {
  const html = `<html><head><title>Untitled Document</title></head><body></body></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Generic placeholder page title")));
});

test("flags a lorem ipsum meta description", () => {
  const html = `<html><head><title>Real Title</title><meta name="description" content="Lorem ipsum dolor sit amet, consectetur adipiscing elit."></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Placeholder meta description")));
});

test('flags "add your description here" style placeholder descriptions', () => {
  const html = `<html><head><title>Real Title</title><meta name="description" content="Add your description here"></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Placeholder meta description")));
});

test("flags a canonical URL pointing at localhost", () => {
  const html = `<html><head><link rel="canonical" href="http://localhost:3000/page"></head></html>`;
  const issues = analyze(html);
  const found = issues.find((i) => i.title.includes("Development/staging URL exposed"));
  assert.ok(found);
  assert.equal(found?.severity, "critical");
});

test("flags an og:image pointing at a staging subdomain", () => {
  const html = `<html><head><meta property="og:image" content="https://staging.example.com/hero.png"></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Development/staging URL exposed")));
});

test("flags a structured-data URL pointing at a Vercel preview host", () => {
  const html = `<html><head><script type="application/ld+json">{"@type":"Organization","name":"Acme","url":"https://acme-preview-a1b2.vercel.app"}</script></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("Development/staging URL exposed")));
});

test("does not flag a normal production canonical URL", () => {
  const html = `<html><head><link rel="canonical" href="https://example.com/page"></head></html>`;
  const issues = analyze(html);
  assert.ok(!issues.some((i) => i.title.includes("Development/staging URL exposed")));
});

test("REGRESSION: does not flag a real slug that merely contains the word 'null' or 'undefined' as part of a larger word/phrase", () => {
  for (const path of ["https://example.com/understanding-null-hypothesis", "https://example.com/callback-undefined-behavior-explained"]) {
    const htmlAnalysis = collectHtml("<html><body>content</body></html>", true);
    const seo = collectSeoExtras("<html><body>content</body></html>", path, {});
    const result = detectAiGeneratedSeoFailures({ finalUrl: path }, htmlAnalysis, seo, null, null);
    assert.ok(!result.some((i) => i.title.includes("looks like generated placeholder content")), `should not flag ${path}`);
  }
});

test("still flags 'undefined'/'null' when it IS the entire path segment", () => {
  for (const path of ["https://example.com/undefined", "https://example.com/products/null"]) {
    const htmlAnalysis = collectHtml("<html><body>content</body></html>", true);
    const seo = collectSeoExtras("<html><body>content</body></html>", path, {});
    const result = detectAiGeneratedSeoFailures({ finalUrl: path }, htmlAnalysis, seo, null, null);
    assert.ok(result.some((i) => i.title.includes("looks like generated placeholder content")), `should flag ${path}`);
  }
});

test("flags a URL path that looks like a generated placeholder page", () => {
  const fetchResult = { finalUrl: "https://example.com/lorem-ipsum-test" };
  const htmlAnalysis = collectHtml("<html><body>content</body></html>", true);
  const seo = collectSeoExtras("<html><body>content</body></html>", fetchResult.finalUrl, {});
  const result = detectAiGeneratedSeoFailures(fetchResult, htmlAnalysis, seo, null, null);
  assert.ok(result.some((i) => i.title.includes("looks like generated placeholder content")));
});

test("does not flag an ordinary URL path", () => {
  const fetchResult = { finalUrl: "https://example.com/handmade-ceramic-mugs" };
  const htmlAnalysis = collectHtml("<html><body>content</body></html>", true);
  const seo = collectSeoExtras("<html><body>content</body></html>", fetchResult.finalUrl, {});
  const result = detectAiGeneratedSeoFailures(fetchResult, htmlAnalysis, seo, null, null);
  assert.ok(!result.some((i) => i.title.includes("looks like generated placeholder content")));
});

test("flags an FAQPage schema where every answer is identical", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@type":"FAQPage","mainEntity":[
      {"@type":"Question","name":"Q1","acceptedAnswer":{"@type":"Answer","text":"Same answer text"}},
      {"@type":"Question","name":"Q2","acceptedAnswer":{"@type":"Answer","text":"Same answer text"}}
    ]}
  </script></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("placeholder or duplicate answers")));
});

test("flags an FAQPage schema with an obvious placeholder answer", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@type":"FAQPage","mainEntity":[
      {"@type":"Question","name":"Q1","acceptedAnswer":{"@type":"Answer","text":"Answer here"}}
    ]}
  </script></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.some((i) => i.title.includes("placeholder or duplicate answers")));
});

test("does not flag a real, distinct FAQPage schema", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@type":"FAQPage","mainEntity":[
      {"@type":"Question","name":"Do you ship internationally?","acceptedAnswer":{"@type":"Answer","text":"Yes, we ship to over 40 countries via tracked airmail."}},
      {"@type":"Question","name":"What is your return policy?","acceptedAnswer":{"@type":"Answer","text":"Unused items can be returned within 30 days for a full refund."}}
    ]}
  </script></head></html>`;
  const issues = analyze(html);
  assert.ok(!issues.some((i) => i.title.includes("placeholder or duplicate answers")));
});

test('flags a catastrophic "Disallow: /" robots.txt as critical', () => {
  const issues = analyze(`<html><head><title>Real Title</title></head></html>`, "User-agent: *\nDisallow: /");
  const found = issues.find((i) => i.title.includes("blocks the entire site"));
  assert.ok(found);
  assert.equal(found?.severity, "critical");
});

test("does not flag a robots.txt that only blocks specific paths", () => {
  const issues = analyze(`<html><head><title>Real Title</title></head></html>`, "User-agent: *\nDisallow: /admin/");
  assert.ok(!issues.some((i) => i.title.includes("blocks the entire site")));
});

test("flags a sitemap that contains localhost URLs", () => {
  const sitemap: SitemapAnalysis = {
    fetched: true,
    available: true,
    sitemapUrl: "https://example.com/sitemap.xml",
    isSitemapIndex: false,
    childSitemapUrls: [],
    urls: [
      { loc: "http://localhost:3000/", lastmod: null, isWellFormedUrl: true },
      { loc: "https://example.com/about", lastmod: null, isWellFormedUrl: true },
    ],
    malformedUrlCount: 0,
    duplicateUrlCount: 0,
    parseError: null,
  };
  const issues = analyze(`<html><head><title>Real Title</title></head></html>`, null, sitemap);
  assert.ok(issues.some((i) => i.title.includes("Sitemap contains development/staging URLs")));
});

test("does not flag a sitemap with only production URLs", () => {
  const sitemap: SitemapAnalysis = {
    fetched: true,
    available: true,
    sitemapUrl: "https://example.com/sitemap.xml",
    isSitemapIndex: false,
    childSitemapUrls: [],
    urls: [{ loc: "https://example.com/about", lastmod: null, isWellFormedUrl: true }],
    malformedUrlCount: 0,
    duplicateUrlCount: 0,
    parseError: null,
  };
  const issues = analyze(`<html><head><title>Real Title</title></head></html>`, null, sitemap);
  assert.ok(!issues.some((i) => i.title.includes("Sitemap contains development/staging URLs")));
});

test("every emitted issue carries evidence, a fix, and an explanation, and never claims the site IS AI-generated", () => {
  const html = `<html><head><title>Home | Website</title><link rel="canonical" href="http://localhost:3000/page"></head></html>`;
  const issues = analyze(html);
  assert.ok(issues.length > 0);
  for (const issue of issues) {
    assert.ok(issue.evidence.length > 0);
    assert.ok(issue.recommendedFix.length > 0);
    assert.ok(issue.whyItMatters.length > 0);
    assert.equal(issue.category, "seo");
    assert.ok(!/ai[- ]generated/i.test(issue.title), "titles should describe the observable failure, not claim AI authorship");
  }
});
