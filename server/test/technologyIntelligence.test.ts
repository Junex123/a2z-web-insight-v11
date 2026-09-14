import test from "node:test";
import assert from "node:assert/strict";
import { detectTechnologies } from "../src/technology/technologyDetector.js";
import { collectTechnologyIntelligence } from "../src/collectors/technologyCollector.js";
import { extractCandidateResources } from "../src/collectors/resourceProbe.js";
import { detectResourceIssues } from "../src/analysis/resourceIssues.js";
import { detectAdvancedSecurityIssues } from "../src/analysis/securityIssues.js";
import type { FetchResult, ResourceIntelligence, SecurityAnalysis } from "../src/types.js";

const baseFetch = (over: Partial<FetchResult> = {}): FetchResult => ({
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  statusCode: 200,
  httpsUsed: true,
  redirected: false,
  redirectCount: 0,
  timing: { approxTtfbMs: 10, totalDownloadMs: 20 },
  headers: { "content-type": "text/html; charset=utf-8" },
  bodyBytes: 1024,
  bodyText: "",
  contentType: "text/html",
  fetchedAt: new Date().toISOString(),
  setCookieHeaders: [],
  ...over,
});

const emptyIntel = (): ResourceIntelligence => ({
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
});

test("technology detector: strong fingerprints, version and false-positive discipline", () => {
  const detected = detectTechnologies({
    url: "https://example.com/",
    html: "<html><body class=\"woocommerce-page\"><script>fbq('init','123');</script></body></html>",
    metaTags: [{ name: "generator", content: "WordPress 6.5.2" }],
    headers: { "cf-ray": "abc" },
    cookieNames: ["woocommerce_cart_hash"],
    resourceUrls: ["https://example.com/wp-content/plugins/woocommerce/a.js"],
  });

  assert.equal(detected.detections.find((d) => d.slug === "wordpress")?.version, "6.5.2");
  assert.equal(detected.detections.find((d) => d.slug === "cloudflare")?.confidence, "high");
  assert.equal(detected.detections.find((d) => d.slug === "woocommerce")?.implied, false);
  assert.equal(detected.detections.find((d) => d.slug === "meta-pixel")?.confidence, "high");

  const falsePositive = detectTechnologies({
    url: "https://example.com/",
    html: "<p>We migrated from WordPress and evaluated Shopify.</p>",
    scriptUrls: ["https://example.com/static/reaction-tracker.js"],
    requestHosts: ["www.facebook.com"],
  });
  assert.equal(falsePositive.detections.length, 0);
  assert.equal(falsePositive.tentative.length, 0);
});

test("technology collector maps existing measured HTTP/HTML evidence without cookie values", () => {
  const report = collectTechnologyIntelligence(
    baseFetch({
      headers: { "content-type": "text/html", "x-shopid": "12345" },
      bodyText: `<!doctype html><html data-wf-page="abc"><head><meta name="generator" content="Webflow"></head><body><script src="https://cdn.shopify.com/theme.js"></script></body></html>`,
      setCookieHeaders: ["session_token=super-secret-value; Secure; HttpOnly"],
    }),
    null,
    emptyIntel(),
  );
  assert.ok(report.detections.some((d) => d.slug === "shopify"));
  assert.ok(report.detections.some((d) => d.slug === "webflow"));
  const cookieEvidence = report.detections.flatMap((d) => d.evidence).find((e) => e.signalType === "cookie-name");
  assert.equal(cookieEvidence, undefined);
});

test("picture/source srcset resources are included in bounded resource probing candidates", () => {
  const candidates = extractCandidateResources(
    `<picture><source srcset="/img/hero.webp 1x, /img/hero@2x.webp 2x"><img src="/img/hero.jpg"></picture>`,
    "https://example.com/",
  );
  assert.ok(candidates.some((c) => c.url.endsWith("/img/hero.webp")));
  assert.ok(candidates.some((c) => c.url.endsWith("/img/hero.jpg")));
});

test("ETag-only static resources get a validator-specific cache finding", () => {
  const intel = emptyIntel();
  intel.entries.push({
    url: "https://example.com/app.js",
    kind: "script",
    origin: "example.com",
    isThirdParty: false,
    probed: true,
    statusCode: 200,
    contentLength: 20_000,
    contentType: "application/javascript",
    cacheControl: null,
    contentEncoding: "br",
    etag: '"abc123"',
    probeError: null,
  });
  intel.totalsByKind.script.count = 1;
  intel.totalsByKind.script.sizeKnownCount = 1;
  intel.totalsByKind.script.knownBytes = 20_000;
  intel.probedCount = 1;
  intel.candidateCount = 1;
  const issues = detectResourceIssues(intel, "<html></html>", "https://example.com/", new Set());
  assert.ok(issues.some((i) => i.title.includes("validators without an explicit freshness lifetime")));
});

function securityFixture(overrides: Partial<SecurityAnalysis> = {}): SecurityAnalysis {
  return {
    csp: { present: true, raw: "script-src 'self'", weaknesses: [] },
    clickjacking: { protected: true, hasXFrameOptions: true, hasCspFrameAncestors: false, conflicting: false },
    mixedContent: [],
    cookies: { observed: true, findings: [] },
    cors: { probeStatus: "checked", allowOriginHeader: null, allowCredentials: false, reflectsArbitraryOrigin: false, wildcardWithCredentialsAttempt: false },
    infoDisclosure: { probeStatus: "checked", checkedPaths: 0, findings: [] },
    debugExposure: { indicators: [] },
    redirectSecurity: { hostChain: [], crossHostRedirect: false, httpProbe: { status: "unreachable", redirectsToHttps: null } },
    crossOriginPolicies: { coop: null, corp: null, coep: null },
    permissionsPolicy: { present: true, raw: "camera=()", wildcardFeatures: [] },
    secretExposure: { probeStatus: "checked", scannedLocations: 0, findings: [] },
    devUrlExposure: { findings: [] },
    httpMethods: { probeStatus: "checked", allowedMethods: ["GET"], riskyMethodsExposed: [] },
    hsts: { present: true, raw: "max-age=31536000", maxAgeSeconds: 31536000, includesSubDomains: true, maxAgeTooShort: false },
    referrerPolicy: { raw: "strict-origin-when-cross-origin", weak: false },
    insecureFormSubmission: { findings: [] },
    tlsCertificate: { probeStatus: "checked", protocol: "TLSv1.3", cipherName: "TLS_AES_128_GCM_SHA256", authorized: true, authorizationError: null, validTo: null, daysUntilExpiry: null },
    caaRecords: { probeStatus: "checked", present: false, records: [] },
    subresourceIntegrity: { findings: [] },
    reverseTabnabbing: { findings: [] },
    verification: {
      https: "verified", headers: "verified", csp: "verified", clickjacking: "verified", cookies: "verified", cors: "verified",
      infoDisclosure: "verified", debugExposure: "verified", redirectSecurity: "verified", crossOriginPolicies: "verified", secretExposure: "verified",
      devUrlExposure: "verified", permissionsPolicy: "verified", httpMethods: "verified", hsts: "verified", referrerPolicy: "verified",
      insecureFormSubmission: "verified", tlsCertificate: "verified", caaRecords: "verified", subresourceIntegrity: "verified",
    },
    ...overrides,
  };
}

test("combined security correlation: reflected CORS + SameSite=None sensitive cookie is critical", () => {
  const security = securityFixture({
    cors: { probeStatus: "checked", allowOriginHeader: "https://evil.example", allowCredentials: true, reflectsArbitraryOrigin: true, wildcardWithCredentialsAttempt: false },
    cookies: { observed: true, findings: [{ name: "session", secure: true, httpOnly: true, sameSite: "None", looksSensitive: true, overlyBroadDomain: false, domain: null }] },
  });
  const issues = detectAdvancedSecurityIssues(security, "https://example.com/");
  assert.ok(issues.some((i) => i.severity === "critical" && i.title.includes("Permissive CORS combined")));
});

test("combined security correlation: unsafe-inline + missing HttpOnly sensitive cookie is critical", () => {
  const security = securityFixture({
    csp: { present: true, raw: "script-src 'self' 'unsafe-inline'", weaknesses: [{ directive: "script-src", issue: "unsafe-inline", detail: "..." }] },
    cookies: { observed: true, findings: [{ name: "session", secure: true, httpOnly: false, sameSite: "Lax", looksSensitive: true, overlyBroadDomain: false, domain: null }] },
  });
  const issues = detectAdvancedSecurityIssues(security, "https://example.com/");
  assert.ok(issues.some((i) => i.severity === "critical" && i.title.includes("Sensitive cookies are readable")));
});
