import assert from "node:assert/strict";
import { test } from "node:test";
import { collectHtml } from "../src/collectors/htmlCollector.js";
import { collectSeoExtras } from "../src/collectors/seoCollector.js";
import { parseRobotsTxt, UNAVAILABLE_ROBOTS } from "../src/collectors/robotsCollector.js";
import { buildSeoVerificationSummary } from "../src/analysis/seoVerification.js";
import type { RobotsTxtAnalysis, SitemapAnalysis } from "../src/types.js";

const PAGE_URL = "https://example.com/page";

const UNAVAILABLE_SITEMAP: SitemapAnalysis = {
  fetched: false,
  available: false,
  sitemapUrl: "https://example.com/sitemap.xml",
  isSitemapIndex: false,
  childSitemapUrls: [],
  urls: [],
  malformedUrlCount: 0,
  duplicateUrlCount: 0,
  parseError: null,
};

function checkFor(checks: ReturnType<typeof buildSeoVerificationSummary>["checks"], id: string) {
  const found = checks.find((c) => c.check === id);
  assert.ok(found, `expected a "${id}" check to be present`);
  return found!;
}

test("every check has a state and a non-empty, specific detail - never a bare pass/fail with no evidence", () => {
  const html = `<html><head><title>Real Title</title></head><body></body></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), UNAVAILABLE_ROBOTS, UNAVAILABLE_SITEMAP);
  for (const check of summary.checks) {
    assert.ok(["verified", "failed", "warning", "unverified", "not_applicable"].includes(check.state));
    assert.ok(check.detail.length > 10);
    assert.ok(check.label.length > 0);
  }
});

test("robots.txt: a definitively-missing robots.txt (fetched, 404) is VERIFIED, not unverified or failed", () => {
  const robots: RobotsTxtAnalysis = { ...UNAVAILABLE_ROBOTS, fetched: true };
  const html = `<html><head><title>T</title></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), robots, UNAVAILABLE_SITEMAP);
  assert.equal(checkFor(summary.checks, "robots_txt").state, "verified");
});

test("robots.txt: a network failure (never got a response at all) is UNVERIFIED, never verified", () => {
  const robots: RobotsTxtAnalysis = { ...UNAVAILABLE_ROBOTS, fetched: false, fetchError: "Request timed out" };
  const html = `<html><head><title>T</title></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), robots, UNAVAILABLE_SITEMAP);
  assert.equal(checkFor(summary.checks, "robots_txt").state, "unverified");
});

test("robots.txt: a successfully retrieved robots.txt is VERIFIED", () => {
  const robots = parseRobotsTxt("User-agent: *\nDisallow: /admin/");
  const html = `<html><head><title>T</title></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), robots, UNAVAILABLE_SITEMAP);
  assert.equal(checkFor(summary.checks, "robots_txt").state, "verified");
});

test("sitemap: a miss at the one location tried is UNVERIFIED, not verified-absent (unlike robots.txt)", () => {
  const html = `<html><head><title>T</title></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), UNAVAILABLE_ROBOTS, UNAVAILABLE_SITEMAP);
  assert.equal(checkFor(summary.checks, "sitemap").state, "unverified");
});

test("sitemap: a successfully retrieved sitemap is VERIFIED", () => {
  const sitemap: SitemapAnalysis = { ...UNAVAILABLE_SITEMAP, fetched: true, available: true, urls: [{ loc: "https://example.com/", lastmod: null, isWellFormedUrl: true }] };
  const html = `<html><head><title>T</title></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), UNAVAILABLE_ROBOTS, sitemap);
  assert.equal(checkFor(summary.checks, "sitemap").state, "verified");
});

test("sitemap: a malformed sitemap that WAS retrieved is FAILED", () => {
  const sitemap: SitemapAnalysis = { ...UNAVAILABLE_SITEMAP, fetched: true, available: false, parseError: "No <urlset> or <sitemapindex> root element found" };
  const html = `<html><head><title>T</title></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), UNAVAILABLE_ROBOTS, sitemap);
  assert.equal(checkFor(summary.checks, "sitemap").state, "failed");
});

test("canonical: missing canonical is WARNING, not a silent pass", () => {
  const html = `<html><head><title>T</title></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), UNAVAILABLE_ROBOTS, UNAVAILABLE_SITEMAP);
  assert.equal(checkFor(summary.checks, "canonical").state, "warning");
});

test("canonical: self-referencing canonical is VERIFIED", () => {
  const html = `<html><head><title>T</title><link rel="canonical" href="https://example.com/page"></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), UNAVAILABLE_ROBOTS, UNAVAILABLE_SITEMAP);
  assert.equal(checkFor(summary.checks, "canonical").state, "verified");
});

test("indexability: conflicting signals is FAILED", () => {
  const html = `<html><head><title>T</title><meta name="robots" content="index"></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, { "x-robots-tag": "noindex" }), UNAVAILABLE_ROBOTS, UNAVAILABLE_SITEMAP);
  assert.equal(checkFor(summary.checks, "indexability").state, "failed");
});

test("structured_data: absent JSON-LD is NOT_APPLICABLE, not failed", () => {
  const html = `<html><head><title>T</title></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), UNAVAILABLE_ROBOTS, UNAVAILABLE_SITEMAP);
  assert.equal(checkFor(summary.checks, "structured_data").state, "not_applicable");
});

test("structured_data: malformed JSON-LD is FAILED", () => {
  const html = `<html><head><title>T</title><script type="application/ld+json">{ invalid </script></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), UNAVAILABLE_ROBOTS, UNAVAILABLE_SITEMAP);
  assert.equal(checkFor(summary.checks, "structured_data").state, "failed");
});

test("structured_data VERIFIED detail explicitly disclaims rich-result eligibility", () => {
  const html = `<html><head><title>T</title><script type="application/ld+json">{"@type":"Organization","name":"Acme","url":"https://example.com"}</script></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), UNAVAILABLE_ROBOTS, UNAVAILABLE_SITEMAP);
  const check = checkFor(summary.checks, "structured_data");
  assert.equal(check.state, "verified");
  assert.match(check.detail, /NOT eligibility/);
});

test("hreflang: absent hreflang is NOT_APPLICABLE (single-language site), not a failure", () => {
  const html = `<html><head><title>T</title></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), UNAVAILABLE_ROBOTS, UNAVAILABLE_SITEMAP);
  assert.equal(checkFor(summary.checks, "hreflang").state, "not_applicable");
});

test("open_graph: absent Open Graph is NOT_APPLICABLE", () => {
  const html = `<html><head><title>T</title></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), UNAVAILABLE_ROBOTS, UNAVAILABLE_SITEMAP);
  assert.equal(checkFor(summary.checks, "open_graph").state, "not_applicable");
});

test("duplicate_metadata and internal_link_graph are always UNVERIFIED for a single-page scan - never silently omitted or marked passing", () => {
  const html = `<html><head><title>T</title></head></html>`;
  const summary = buildSeoVerificationSummary(collectHtml(html, true), collectSeoExtras(html, PAGE_URL, {}), UNAVAILABLE_ROBOTS, UNAVAILABLE_SITEMAP);
  assert.equal(checkFor(summary.checks, "duplicate_metadata").state, "unverified");
  assert.equal(checkFor(summary.checks, "internal_link_graph").state, "unverified");
});
