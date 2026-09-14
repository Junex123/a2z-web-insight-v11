import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePageSpeedResponse } from "../src/providers/pageSpeedProvider.js";

function payloadWithAudits(audits: Record<string, unknown>) {
  return {
    lighthouseResult: {
      categories: { performance: { score: 0.5 } },
      audits: {
        "largest-contentful-paint": { numericValue: 2000 },
        ...audits,
      },
    },
  };
}

test("resource-summary is parsed into per-type transfer bytes/request counts", () => {
  const payload = payloadWithAudits({
    "resource-summary": {
      details: {
        type: "table",
        items: [
          { resourceType: "script", requestCount: 5, transferSize: 400_000 },
          { resourceType: "image", requestCount: 10, transferSize: 900_000 },
          { resourceType: "total", requestCount: 20, transferSize: 1_500_000 },
        ],
      },
    },
  });
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.ok(evidence?.resources);
  assert.equal(evidence!.resources!.resourceSummary.length, 2); // "total" row excluded
  const js = evidence!.resources!.resourceSummary.find((r) => r.type === "script");
  assert.equal(js?.transferSize, 400_000);
  assert.equal(js?.requestCount, 5);
});

test("an unrecognized resourceType is bucketed as 'other' rather than dropped or misclassified", () => {
  const payload = payloadWithAudits({
    "resource-summary": { details: { type: "table", items: [{ resourceType: "wasm", requestCount: 1, transferSize: 5000 }] } },
  });
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.resources!.resourceSummary[0].type, "other");
});

test("render-blocking-resources items are extracted with url and wastedMs", () => {
  const payload = payloadWithAudits({
    "render-blocking-resources": {
      details: { type: "opportunity", overallSavingsMs: 500, items: [{ url: "https://example.com/a.css", wastedMs: 300 }] },
    },
  });
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.resources!.renderBlockingResources.length, 1);
  assert.equal(evidence!.resources!.renderBlockingResources[0].url, "https://example.com/a.css");
  assert.equal(evidence!.resources!.renderBlockingResources[0].wastedMs, 300);
});

test("third-party-summary items are extracted with entity name, transfer size, blocking time, and a deterministic category", () => {
  const payload = payloadWithAudits({
    "third-party-summary": {
      details: {
        type: "table",
        items: [{ entity: { type: "link", text: "Google Analytics", url: "https://analytics.google.com" }, transferSize: 55_000, blockingTime: 40 }],
      },
    },
  });
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.resources!.thirdParty[0].entity, "Google Analytics");
  assert.equal(evidence!.resources!.thirdParty[0].transferSize, 55_000);
  assert.equal(evidence!.resources!.thirdParty[0].blockingTimeMs, 40);
  assert.equal(evidence!.resources!.thirdParty[0].category, "analytics");
});

test("uses-long-cache-ttl provides both an overall savings figure and specific cacheable assets", () => {
  const payload = payloadWithAudits({
    "uses-long-cache-ttl": {
      details: {
        type: "opportunity",
        overallSavingsBytes: 40_000,
        items: [{ url: "https://example.com/app.js", cacheLifetimeMs: 0, wastedBytes: 40_000 }],
      },
    },
  });
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.resources!.longCacheTtlWastedBytes, 40_000);
  assert.equal(evidence!.resources!.cacheableAssets[0].url, "https://example.com/app.js");
});

test("total-byte-weight and dom-size are read as plain numeric audit values", () => {
  const payload = payloadWithAudits({
    "total-byte-weight": { numericValue: 2_100_000 },
    "dom-size": { numericValue: 1800 },
  });
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.resources!.totalTransferBytes, 2_100_000);
  assert.equal(evidence!.resources!.domSize, 1800);
});

test("font-display audit presence -> count + specific flagged font URLs; absence -> null/[], never a fabricated 0", () => {
  const withIssue = normalizePageSpeedResponse(
    payloadWithAudits({ "font-display": { details: { type: "table", items: [{ url: "https://example.com/font.woff2", wastedMs: 100 }] } } }),
    "mobile",
  );
  assert.equal(withIssue!.resources!.fontDisplayIssueCount, 1);
  assert.equal(withIssue!.resources!.fontDisplayItems[0].url, "https://example.com/font.woff2");
  assert.equal(withIssue!.resources!.fontDisplayItems[0].wastedMs, 100);

  const withoutAudit = normalizePageSpeedResponse(payloadWithAudits({}), "mobile");
  assert.equal(withoutAudit!.resources!.fontDisplayIssueCount, null);
  assert.deepEqual(withoutAudit!.resources!.fontDisplayItems, []);
});

test("a response with none of the resource-level audits results in an all-null/empty ResourceEvidence, not fabricated data", () => {
  const evidence = normalizePageSpeedResponse(payloadWithAudits({}), "mobile");
  const r = evidence!.resources!;
  assert.equal(r.totalTransferBytes, null);
  assert.equal(r.resourceSummary.length, 0);
  assert.equal(r.renderBlockingResources.length, 0);
  assert.equal(r.thirdParty.length, 0);
  assert.equal(r.unusedCssBytes, null);
  assert.equal(r.longCacheTtlWastedBytes, null);
  assert.equal(r.domSize, null);
});

test("regression: existing metric extraction (LCP, opportunities) is unaffected by the new resources field", () => {
  const payload = payloadWithAudits({
    "cumulative-layout-shift": { numericValue: 0.02 },
    "render-blocking-resources": { title: "Eliminate render-blocking resources", details: { type: "opportunity", overallSavingsMs: 200 } },
  });
  const evidence = normalizePageSpeedResponse(payload, "mobile");
  assert.equal(evidence!.metrics.lcp.value, 2000);
  assert.equal(evidence!.metrics.cls.value, 0.02);
  assert.equal(evidence!.opportunities[0].id, "render-blocking-resources");
});
