import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPerformanceVerificationSummary } from "../src/analysis/performanceVerification.js";
import type { PerformanceProviderResult, ResourceIntelligence } from "../src/types.js";

const EMPTY_INTEL: ResourceIntelligence = {
  entries: [],
  totalsByKind: {
    script: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
    stylesheet: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
    image: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
    font: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
    other: { count: 0, sizeKnownCount: 0, knownBytes: 0 },
  },
  thirdParty: { originCount: 0, requestCount: 0, knownBytes: 0, origins: [] },
  truncated: false,
  candidateCount: 0,
  probedCount: 0,
};

function checkFor(summary: ReturnType<typeof buildPerformanceVerificationSummary>, id: string) {
  const found = summary.checks.find((c) => c.check === id);
  assert.ok(found, `expected a "${id}" check`);
  return found!;
}

test("every check has a real state and a non-empty, specific detail", () => {
  const summary = buildPerformanceVerificationSummary({ status: "not_configured", evidence: null }, EMPTY_INTEL);
  for (const check of summary.checks) {
    assert.ok(["verified", "failed", "warning", "unverified", "not_applicable"].includes(check.state));
    assert.ok(check.detail.length > 10);
  }
});

test("core_web_vitals: not_configured is NOT_APPLICABLE, not unverified or failed", () => {
  const summary = buildPerformanceVerificationSummary({ status: "not_configured", evidence: null }, EMPTY_INTEL);
  assert.equal(checkFor(summary, "core_web_vitals").state, "not_applicable");
});

test("core_web_vitals: available is VERIFIED", () => {
  const providerResult: PerformanceProviderResult = {
    status: "available",
    evidence: {
      strategy: "mobile",
      lighthousePerformanceScore: 80,
      metrics: {} as any,
      opportunities: [],
      coverage: { metricsAvailable: 5, metricsTotal: 7 },
    },
  };
  const summary = buildPerformanceVerificationSummary(providerResult, EMPTY_INTEL);
  assert.equal(checkFor(summary, "core_web_vitals").state, "verified");
});

test("core_web_vitals: timeout/rate_limited/error are UNVERIFIED, never silently passing", () => {
  for (const status of ["timeout", "rate_limited", "error"] as const) {
    const summary = buildPerformanceVerificationSummary({ status, evidence: null, errorMessage: "x" }, EMPTY_INTEL);
    assert.equal(checkFor(summary, "core_web_vitals").state, "unverified", `status ${status} should be unverified`);
  }
});

test("resource_probe: no candidate resources is NOT_APPLICABLE", () => {
  const summary = buildPerformanceVerificationSummary({ status: "not_configured", evidence: null }, EMPTY_INTEL);
  assert.equal(checkFor(summary, "resource_probe").state, "not_applicable");
});

test("resource_probe: fully probed with no truncation is VERIFIED", () => {
  const intel: ResourceIntelligence = {
    ...EMPTY_INTEL,
    entries: [{ url: "https://example.com/a.js", kind: "script", origin: "example.com", isThirdParty: false, probed: true, statusCode: 200, contentLength: 100, contentType: null, cacheControl: null, contentEncoding: null, etag: null, probeError: null }],
    candidateCount: 1,
    probedCount: 1,
    truncated: false,
  };
  const summary = buildPerformanceVerificationSummary({ status: "not_configured", evidence: null }, intel);
  assert.equal(checkFor(summary, "resource_probe").state, "verified");
});

test("resource_probe: truncated (cap hit) is WARNING, not silently reported as complete", () => {
  const intel: ResourceIntelligence = { ...EMPTY_INTEL, candidateCount: 100, probedCount: 40, truncated: true };
  const summary = buildPerformanceVerificationSummary({ status: "not_configured", evidence: null }, intel);
  const check = checkFor(summary, "resource_probe");
  assert.equal(check.state, "warning");
  assert.match(check.detail, /partial/i);
});

test("resource_probe: some resources unreachable is WARNING", () => {
  const intel: ResourceIntelligence = {
    ...EMPTY_INTEL,
    entries: [{ url: "https://example.com/a.js", kind: "script", origin: "example.com", isThirdParty: false, probed: false, statusCode: null, contentLength: null, contentType: null, cacheControl: null, contentEncoding: null, etag: null, probeError: "timeout" }],
    candidateCount: 1,
    probedCount: 1,
    truncated: false,
  };
  const summary = buildPerformanceVerificationSummary({ status: "not_configured", evidence: null }, intel);
  assert.equal(checkFor(summary, "resource_probe").state, "warning");
});

test("browser_runtime is always UNVERIFIED - this system has no browser/runtime collector", () => {
  const summary = buildPerformanceVerificationSummary({ status: "available", evidence: null }, EMPTY_INTEL);
  assert.equal(checkFor(summary, "browser_runtime").state, "unverified");
});
