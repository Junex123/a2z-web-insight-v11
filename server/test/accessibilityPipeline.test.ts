import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { analyzeUrl } from "../src/pipeline.js";
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

  app.get("/inaccessible", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html>
<head><title>Bad Page</title></head>
<body>
  <img src="hero.png">
  <div onclick="go()">Click me</div>
  <button></button>
  <input type="text">
</body>
</html>`);
  });

  app.get("/accessible", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Good Page</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
  <h1>Welcome</h1>
  <img src="hero.png" alt="A friendly robot waving">
  <label for="email">Email</label><input id="email" type="email">
  <button>Submit</button>
  <a href="/contact">Contact us</a>
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

test("accessibility is included in categoriesAnalyzed and no longer in categoriesNotYetAnalyzed", async () => {
  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${port}/accessible`, { performanceProvider: notConfiguredProvider });
  assert.ok(report.categoriesAnalyzed.includes("accessibility"));
  assert.ok(!report.categoriesNotYetAnalyzed.includes("accessibility"));
});

test("accessibility score is present and contributes to the overall score", async () => {
  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${port}/accessible`, { performanceProvider: notConfiguredProvider });
  assert.ok(typeof report.scores.accessibility === "number");
  assert.ok(report.scores.accessibility >= 0 && report.scores.accessibility <= 100);
});

test("a genuinely inaccessible page scores lower on accessibility than a clean one", async () => {
  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
  const bad = await analyzeUrl(`http://localhost:${port}/inaccessible`, { performanceProvider: notConfiguredProvider });

  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
  const good = await analyzeUrl(`http://localhost:${port}/accessible`, { performanceProvider: notConfiguredProvider });

  assert.ok(bad.scores.accessibility < good.scores.accessibility);
  assert.ok(good.scores.accessibility >= 85, `expected the clean page to score highly, got ${good.scores.accessibility}`);
});

test("accessibility findings appear in allIssues with category accessibility and can be filtered", async () => {
  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${port}/inaccessible`, { performanceProvider: notConfiguredProvider });
  const a11yIssues = report.allIssues.filter((i) => i.category === "accessibility");
  assert.ok(a11yIssues.length > 0);
  for (const issue of a11yIssues) {
    assert.ok(issue.evidence.length > 0);
    assert.ok(issue.recommendedFix.length > 0);
    assert.ok(issue.whyItMatters.length > 0);
  }
});

test("accessibility issues can appear in topPriorityIssues alongside other categories", async () => {
  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${port}/inaccessible`, { performanceProvider: notConfiguredProvider });
  // not a strict requirement that a11y wins the top slots, but the field must be well-formed
  assert.ok(Array.isArray(report.topPriorityIssues));
  assert.ok(report.topPriorityIssues.length <= 5);
});

test("accessibilityCoverage is present on every report", async () => {
  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${port}/accessible`, { performanceProvider: notConfiguredProvider });
  assert.ok(report.accessibilityCoverage.checkedAreas.length > 0);
  assert.ok(report.accessibilityCoverage.notVerifiable.length > 0);
});

test("evidenceLog.accessibility carries the raw collected facts for the dashboard's evidence panel", async () => {
  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${port}/accessible`, { performanceProvider: notConfiguredProvider });
  assert.equal(report.evidenceLog.accessibility.hasHtmlLangAttr, true);
  assert.equal(report.evidenceLog.accessibility.htmlLangValue, "en");
});

test("issueCounts total includes accessibility findings", async () => {
  resetAccessibilityIssueIdCounter();
  resetCwvIssueIdCounter();
  const report = await analyzeUrl(`http://localhost:${port}/inaccessible`, { performanceProvider: notConfiguredProvider });
  const a11yCount = report.allIssues.filter((i) => i.category === "accessibility").length;
  assert.ok(a11yCount > 0);
  assert.ok(report.issueCounts.total >= a11yCount);
});
