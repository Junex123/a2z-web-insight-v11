import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { analyzeUrl } from "../src/pipeline.js";
import { resetIssueIdCounter } from "../src/analysis/issues.js";
import { resetSeoIssueIdCounter } from "../src/analysis/seoIssues.js";
import { resetAiGeneratedSeoIssueIdCounter } from "../src/analysis/aiGeneratedSeoIssues.js";
import { resetAccessibilityIssueIdCounter } from "../src/analysis/accessibilityIssues.js";
import { resetCwvIssueIdCounter } from "../src/analysis/cwvIssues.js";
import type { PerformanceProvider } from "../src/types.js";

process.env.ALLOW_LOCAL_TARGETS = "true";
delete process.env.PAGESPEED_INSIGHTS_API_KEY;
delete process.env.PAGESPEED_API_KEY;

const notConfiguredProvider: PerformanceProvider = {
  name: "test-provider",
  analyze: async () => ({ status: "not_configured", evidence: null, errorMessage: "no key" }),
};

let server: Server;
let port: number;

before(async () => {
  const app = express();

  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /blocked-page\n");
  });

  app.get("/seo-clean", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clean SEO Demo Page - A Well Optimized Example</title>
  <meta name="description" content="A clean, well-optimized demo page used to verify the advanced SEO analyzer does not produce false positives on healthy pages here.">
  <link rel="canonical" href="http://localhost:${port}/seo-clean">
  <meta property="og:title" content="Clean SEO Demo Page">
  <meta property="og:description" content="A clean demo page.">
  <meta property="og:image" content="http://localhost:${port}/og.png">
</head>
<body>
  <h1>Clean SEO Demo Page</h1>
  <p>${"This page has plenty of genuinely descriptive content about the subject matter at hand. ".repeat(10)}</p>
  <img src="/hero.png" alt="Descriptive hero image" width="800" height="400">
  <a href="/another-page">See another page</a>
</body>
</html>`);
  });

  app.get("/seo-messy", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html>
<head>
  <link rel="canonical" href="https://totally-different-domain.example/somewhere-else">
  <script type="application/ld+json">{ this is not valid json ]</script>
</head>
<body>
  <p>Hi.</p>
</body>
</html>`);
  });

  app.get("/blocked-page", (_req, res) => {
    res.type("html").send(`<html><head><title>Blocked Page</title></head><body><h1>Blocked Page</h1></body></html>`);
  });

  app.get("/generic-title-page", (_req, res) => {
    // deliberately no canonical/OG here, so this test isolates the
    // placeholder-title check from the (accurate, but noisy for this
    // purpose) localhost dev-URL check every other route on this test
    // server would also trigger via its canonical/og tags.
    res.type("html").send(`<html><head><title>Home | Website</title></head><body><p>${"Some body text so this isn't also flagged as thin content. ".repeat(6)}</p></body></html>`);
  });

  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as any).port;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

function resetAllCounters() {
  resetIssueIdCounter();
  resetSeoIssueIdCounter();
  resetAiGeneratedSeoIssueIdCounter();
  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
}

test("evidenceLog.seo carries the extended SEO facts for the dashboard's evidence panel", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/seo-clean`, { performanceProvider: notConfiguredProvider });
  assert.ok(report.evidenceLog.seo);
  assert.equal(report.evidenceLog.seo.canonical.isSelfReferencing, true);
  assert.equal(report.evidenceLog.seo.openGraph.ogTitle, "Clean SEO Demo Page");
});

test("robotsTxt is fetched best-effort and included on every report", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/seo-clean`, { performanceProvider: notConfiguredProvider });
  assert.equal(report.robotsTxt.available, true);
  assert.ok(report.robotsTxt.groups.length > 0);
});

test("a clean SEO page produces no advanced SEO findings (no false positives)", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/seo-clean`, { performanceProvider: notConfiguredProvider });
  const advancedSeoIssues = report.allIssues.filter((i) => i.id.startsWith("seo-adv-"));
  assert.deepEqual(advancedSeoIssues, []);
});

test("a genuinely problematic SEO page produces advanced SEO findings alongside the existing basic SEO findings", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/seo-messy`, { performanceProvider: notConfiguredProvider });
  const seoIssues = report.allIssues.filter((i) => i.category === "seo");
  const basicSeoIssues = seoIssues.filter((i) => !i.id.startsWith("seo-adv-") && !i.id.startsWith("seo-ai-"));
  const advancedSeoIssues = seoIssues.filter((i) => i.id.startsWith("seo-adv-"));

  assert.ok(basicSeoIssues.length > 0, "existing basic SEO rules (missing title, missing description, etc.) should still fire");
  assert.ok(advancedSeoIssues.length > 0, "new advanced SEO rules (cross-domain canonical, malformed JSON-LD, thin content) should fire");
  assert.ok(advancedSeoIssues.some((i) => i.title.includes("different domain")));
  assert.ok(advancedSeoIssues.some((i) => i.title.includes("Malformed JSON-LD")));
});

test("robots.txt-blocked page is flagged via the pipeline", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/blocked-page`, { performanceProvider: notConfiguredProvider });
  assert.ok(report.allIssues.some((i) => i.title.includes("blocked by robots.txt")));
});

test("SEO category is still in categoriesAnalyzed (advanced SEO is additive, not a new category)", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/seo-clean`, { performanceProvider: notConfiguredProvider });
  assert.ok(report.categoriesAnalyzed.includes("seo"));
  assert.equal(report.categoriesAnalyzed.filter((c) => c === "seo").length, 1);
});

test("advanced SEO findings count toward the seo score like any other seo issue", async () => {
  resetAllCounters();
  const messy = await analyzeUrl(`http://localhost:${port}/seo-messy`, { performanceProvider: notConfiguredProvider });
  resetAllCounters();
  const clean = await analyzeUrl(`http://localhost:${port}/seo-clean`, { performanceProvider: notConfiguredProvider });
  assert.ok(messy.scores.seo < clean.scores.seo);
});

test("report.sitemap is present on every report (best-effort, unavailable here since this test server has no sitemap.xml)", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/seo-clean`, { performanceProvider: notConfiguredProvider });
  assert.ok(report.sitemap);
  assert.equal(report.sitemap.available, false);
});

test("report.seoVerification is present and never silently claims something unchecked passed", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/seo-clean`, { performanceProvider: notConfiguredProvider });
  assert.ok(report.seoVerification.checks.length > 0);
  const robotsCheck = report.seoVerification.checks.find((c) => c.check === "robots_txt");
  assert.equal(robotsCheck?.state, "verified"); // this test server does serve a robots.txt
  const siteWideCheck = report.seoVerification.checks.find((c) => c.check === "internal_link_graph");
  assert.equal(siteWideCheck?.state, "unverified"); // single-page scan - must never claim this is verified
});

test("this test server's own canonical/og URLs (on localhost) are correctly flagged as a dev-host leak end to end", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/seo-clean`, { performanceProvider: notConfiguredProvider });
  assert.ok(report.allIssues.some((i) => i.title.includes("Development/staging URL exposed")));
});

test("a generic placeholder title is flagged via the pipeline", async () => {
  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${port}/generic-title-page`, { performanceProvider: notConfiguredProvider });
  assert.ok(report.allIssues.some((i) => i.title.includes("Generic placeholder page title")));
});

test("a catastrophic site-wide robots.txt block is flagged as critical via the pipeline", async () => {
  const blockedApp = express();
  blockedApp.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));
  blockedApp.get("/home", (_req, res) => res.type("html").send(`<html><head><title>Real Site Title</title></head><body><p>content</p></body></html>`));
  const blockedServer = blockedApp.listen(0);
  await new Promise((r) => blockedServer.once("listening", r));
  const blockedPort = (blockedServer.address() as any).port;

  resetAllCounters();
  const report = await analyzeUrl(`http://localhost:${blockedPort}/home`, { performanceProvider: notConfiguredProvider });
  const found = report.allIssues.find((i) => i.title.includes("blocks the entire site"));
  assert.ok(found);
  assert.equal(found?.severity, "critical");

  await new Promise((r) => blockedServer.close(r));
});
