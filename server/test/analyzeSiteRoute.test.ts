import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { resetAccessibilityIssueIdCounter } from "../src/analysis/accessibilityIssues.js";
import { resetUxIssueIdCounter } from "../src/analysis/uxIssues.js";
import type { SiteAnalysisReport } from "../src/types.js";

process.env.ALLOW_LOCAL_TARGETS = "true";

let mockServer: Server;
let appServer: Server;
let mockPort: number;
let appPort: number;

before(async () => {
  const { default: mockApp } = await import("../mock-site/app.js");
  mockServer = mockApp.listen(0);
  await new Promise((r) => mockServer.once("listening", r));
  mockPort = (mockServer.address() as any).port;

  const app = createApp({ rateLimiter: false });
  appServer = app.listen(0);
  await new Promise((r) => appServer.once("listening", r));
  appPort = (appServer.address() as any).port;
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
  await new Promise((r) => appServer.close(r));
});

async function analyzeSite(paths: string[]): Promise<{ status: number; body: SiteAnalysisReport | any }> {
  const res = await fetch(`http://localhost:${appPort}/api/analyze-site`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: paths.map((p) => `http://localhost:${mockPort}${p}`) }),
  });
  return { status: res.status, body: await res.json() };
}

test("rejects a request with no urls array", async () => {
  const res = await fetch(`http://localhost:${appPort}/api/analyze-site`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("scans the multi-page mock-site fixture and returns one result per page", async () => {
  resetAccessibilityIssueIdCounter();
  resetUxIssueIdCounter();
  const { status, body } = await analyzeSite(["/site/home", "/site/about", "/site/clean"]);
  assert.equal(status, 200);
  assert.equal(body.pagesScanned, 3);
  assert.equal(body.pages.length, 3);
});

test("the fully clean fixture page scores clean with zero page-level issues", async () => {
  resetAccessibilityIssueIdCounter();
  resetUxIssueIdCounter();
  const { body } = await analyzeSite(["/site/clean"]);
  const page = body.pages[0];
  assert.equal(page.outcome, "clean");
  assert.equal(page.issueCounts.total, 0);
});

test("placeholder and coming-soon fixture pages are flagged with evidence-backed UX findings", async () => {
  resetAccessibilityIssueIdCounter();
  resetUxIssueIdCounter();
  const { body } = await analyzeSite(["/site/placeholder", "/site/coming-soon"]);
  const placeholder = body.pages.find((p: any) => p.url.endsWith("/site/placeholder"));
  const comingSoon = body.pages.find((p: any) => p.url.endsWith("/site/coming-soon"));
  assert.ok(placeholder.issues.some((i: any) => i.title.toLowerCase().includes("placeholder")));
  assert.ok(comingSoon.issues.some((i: any) => i.title.toLowerCase().includes("coming soon")));
});

test("a dead-end fixture page (no nav, no links at all) is flagged", async () => {
  resetAccessibilityIssueIdCounter();
  resetUxIssueIdCounter();
  const { body } = await analyzeSite(["/site/dead-end"]);
  const page = body.pages[0];
  assert.ok(page.issues.some((i: any) => i.title.toLowerCase().includes("dead-end")));
});

test("duplicate titles across /site/home and /site/about surface as one site-level finding with both URLs", async () => {
  resetAccessibilityIssueIdCounter();
  resetUxIssueIdCounter();
  const { body } = await analyzeSite(["/site/home", "/site/about", "/site/clean"]);
  const dup = body.siteFindings.find((f: any) => f.key.startsWith("duplicate-title:"));
  assert.ok(dup);
  assert.equal(dup.affectedPageCount, 2);
  assert.ok(dup.affectedUrls.some((u: string) => u.endsWith("/site/home")));
  assert.ok(dup.affectedUrls.some((u: string) => u.endsWith("/site/about")));
});

test("the shared missing-lang template bug on /site/home and /site/about collapses into one repeated finding", async () => {
  resetAccessibilityIssueIdCounter();
  resetUxIssueIdCounter();
  const { body } = await analyzeSite(["/site/home", "/site/about", "/site/clean"]);
  const repeated = body.siteFindings.find((f: any) => f.key.includes("Missing lang attribute"));
  assert.ok(repeated);
  assert.equal(repeated.affectedPageCount, 2);
});
