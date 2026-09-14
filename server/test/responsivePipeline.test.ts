import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { analyzeUrl } from "../src/pipeline.js";
import { resetResponsiveIssueIdCounter } from "../src/analysis/responsiveIssues.js";
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

  // 1. Excellent responsive site - device-width viewport, real media queries,
  // responsive images, a single sensible nav.
  app.get("/excellent-responsive", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Excellent Responsive Site</title>
  <style>
    img { max-width: 100%; height: auto; }
    .layout { display: flex; flex-wrap: wrap; }
    @media (max-width: 768px) { .sidebar { display: none; } }
    @media (max-width: 480px) { .layout { flex-direction: column; } }
  </style>
</head>
<body>
  <nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>
  <h1>Welcome</h1>
  <p>This site genuinely adapts to different screen sizes using modern, flexible CSS.</p>
  <img src="hero.jpg" alt="Hero" srcset="hero-800.jpg 800w, hero-1600.jpg 1600w" sizes="100vw">
</body>
</html>`);
  });

  // 2. Desktop-only site - fixed numeric viewport width, no media queries,
  // large fixed-width containers, oversized static images.
  app.get("/desktop-only", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1200">
  <title>Desktop Only Site</title>
  <style>
    .container { width: 1200px; }
    .banner { width: 1600px; }
  </style>
</head>
<body>
  <nav>
    <a href="/">Home</a><a href="/products">Products</a><a href="/services">Services</a>
    <a href="/about">About</a><a href="/team">Team</a><a href="/blog">Blog</a>
    <a href="/careers">Careers</a><a href="/press">Press</a><a href="/partners">Partners</a>
    <a href="/support">Support</a><a href="/contact">Contact</a><a href="/legal">Legal</a>
  </nav>
  <h1>Desktop Only Site</h1>
  <p>This site was built assuming every visitor has a wide desktop monitor and nothing else.</p>
  <img src="banner.jpg" width="1800">
</body>
</html>`);
  });

  // 3. Partially responsive site - has a device-width viewport and SOME media
  // queries, but also a leftover duplicate nav and a 100vw hero.
  app.get("/partially-responsive", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Partially Responsive Site</title>
  <style>
    @media (max-width: 600px) { .sidebar { display: none; } }
    .hero { width: 100vw; }
  </style>
</head>
<body>
  <nav id="new-nav"><a href="/">Home</a><a href="/shop">Shop</a><a href="/cart">Cart</a></nav>
  <nav id="old-nav-leftover"><a href="/">Start</a><a href="/shop">Browse</a><a href="/cart">Basket</a></nav>
  <h1>Partially Responsive Site</h1>
  <p>Some parts of this redesign adapted to mobile, others clearly did not get finished.</p>
</body>
</html>`);
  });

  // 4. AI-generated unfinished site - no viewport at all, no CSS at all,
  // empty nav controls, a huge unlabeled image.
  app.get("/ai-generated-unfinished", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Untitled Site</title>
</head>
<body>
  <nav><a href="/"></a><button></button><a href="/about">About</a></nav>
  <h1>Welcome</h1>
  <p>Lorem ipsum dolor sit amet placeholder text that was never replaced with anything real.</p>
  <img src="placeholder.jpg" width="2400">
</body>
</html>`);
  });

  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as any).port;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

function resetCounters() {
  resetResponsiveIssueIdCounter();
  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
}

test("responsiveness is included in categoriesAnalyzed", async () => {
  resetCounters();
  const report = await analyzeUrl(`http://localhost:${port}/excellent-responsive`, { performanceProvider: notConfiguredProvider });
  assert.ok(report.categoriesAnalyzed.includes("responsiveness"));
});

test("responsiveness score is present, bounded, and contributes to the overall average", async () => {
  resetCounters();
  const report = await analyzeUrl(`http://localhost:${port}/excellent-responsive`, { performanceProvider: notConfiguredProvider });
  assert.equal(typeof report.scores.responsiveness, "number");
  assert.ok(report.scores.responsiveness >= 0 && report.scores.responsiveness <= 100);
});

test("mock 1 - excellent responsive site scores highly with no responsiveness issues", async () => {
  resetCounters();
  const report = await analyzeUrl(`http://localhost:${port}/excellent-responsive`, { performanceProvider: notConfiguredProvider });
  const responsiveIssues = report.allIssues.filter((i) => i.category === "responsiveness");
  assert.equal(responsiveIssues.length, 0, `expected zero responsiveness issues, got: ${responsiveIssues.map((i) => i.title).join(", ")}`);
  assert.equal(report.scores.responsiveness, 100);
  assert.equal(report.responsiveVerification.mobile.failures, 0);
  assert.equal(report.responsiveVerification.mobile.warnings, 0);
});

test("mock 2 - desktop-only site is flagged with multiple mobile-risk findings", async () => {
  resetCounters();
  const report = await analyzeUrl(`http://localhost:${port}/desktop-only`, { performanceProvider: notConfiguredProvider });
  const responsiveIssues = report.allIssues.filter((i) => i.category === "responsiveness");
  const titles = responsiveIssues.map((i) => i.title.toLowerCase());
  assert.ok(titles.some((t) => t.includes("hardcoded pixel width")), "should flag the fixed-width viewport");
  assert.ok(titles.some((t) => t.includes("fixed-width css") || t.includes("very large fixed-width")), "should flag fixed-width CSS");
  assert.ok(titles.some((t) => t.includes("many top-level links")), "should flag the large flat nav menu");
  assert.ok(titles.some((t) => t.includes("srcset")), "should flag the oversized static image");
  assert.ok(report.scores.responsiveness < 100);
});

test("mock 3 - partially responsive site is flagged for its specific unfinished parts, not blanket-failed", async () => {
  resetCounters();
  const report = await analyzeUrl(`http://localhost:${port}/partially-responsive`, { performanceProvider: notConfiguredProvider });
  const responsiveIssues = report.allIssues.filter((i) => i.category === "responsiveness");
  const titles = responsiveIssues.map((i) => i.title.toLowerCase());
  assert.ok(titles.some((t) => t.includes("duplicate")), "should flag the leftover duplicate nav");
  assert.ok(titles.some((t) => t.includes("100vw")), "should flag the 100vw hero");
  // this page DOES have a device-width viewport and real media queries -
  // that must not be penalized just because other things are wrong
  assert.ok(!titles.some((t) => t.includes("hardcoded pixel width")), "viewport itself is healthy on this fixture and must not be flagged");
  const breakpointCheck = report.responsiveVerification.checks.find((c) => c.id === "css-breakpoint-evidence")!;
  assert.equal(breakpointCheck.state, "passed");
});

test("mock 4 - AI-generated unfinished site is flagged for missing viewport and CSS evidence is honestly unverified", async () => {
  resetCounters();
  const report = await analyzeUrl(`http://localhost:${port}/ai-generated-unfinished`, { performanceProvider: notConfiguredProvider });
  const viewportCheck = report.responsiveVerification.checks.find((c) => c.id === "viewport-meta-present")!;
  assert.equal(viewportCheck.state, "failed");
  const breakpointCheck = report.responsiveVerification.checks.find((c) => c.id === "css-breakpoint-evidence")!;
  assert.equal(breakpointCheck.state, "unverified", "no CSS at all must be honestly unverified, not silently treated as passing");
  const responsiveIssues = report.allIssues.filter((i) => i.category === "responsiveness");
  assert.ok(responsiveIssues.some((i) => i.title.toLowerCase().includes("srcset")), "should flag the huge unlabeled image");
});

test("the structurally-unverified runtime checks (rendered overflow, touch targets, desktop layout, device-specific Lighthouse) appear on every report", async () => {
  resetCounters();
  const report = await analyzeUrl(`http://localhost:${port}/excellent-responsive`, { performanceProvider: notConfiguredProvider });
  const ids = report.responsiveVerification.checks.map((c) => c.id);
  for (const id of ["rendered-overflow-verification", "touch-target-sizing", "rendered-layout-desktop", "device-specific-lighthouse-scores"]) {
    assert.ok(ids.includes(id));
    assert.equal(report.responsiveVerification.checks.find((c) => c.id === id)!.state, "unverified");
  }
});

test("evidenceLog.responsive carries the raw collected facts", async () => {
  resetCounters();
  const report = await analyzeUrl(`http://localhost:${port}/excellent-responsive`, { performanceProvider: notConfiguredProvider });
  assert.equal(report.evidenceLog.responsive.viewport.hasDeviceWidthToken, true);
  assert.equal(report.evidenceLog.responsive.navigation.navElementCount, 1);
});

test("responsiveness findings can appear in topPriorityIssues alongside other categories", async () => {
  resetCounters();
  const report = await analyzeUrl(`http://localhost:${port}/desktop-only`, { performanceProvider: notConfiguredProvider });
  assert.ok(Array.isArray(report.topPriorityIssues));
  assert.ok(report.topPriorityIssues.length <= 5);
});

test("responsiveness participates in the Launch Decision as PARTIALLY_VERIFIED, never fully VERIFIED", async () => {
  resetCounters();
  const report = await analyzeUrl(`http://localhost:${port}/excellent-responsive`, { performanceProvider: notConfiguredProvider });
  const readiness = report.launchDecision.categoryReadiness.find((c) => c.category === "responsiveness");
  assert.ok(readiness, "responsiveness should appear in the launch decision's category readiness list");
  assert.equal(readiness!.verification, "PARTIALLY_VERIFIED");
});
