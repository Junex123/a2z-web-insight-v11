import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAdvancedSecurityIssues, resetAdvancedSecurityIssueIdCounter } from "../src/analysis/securityIssues.js";
import type { SecurityAnalysis } from "../src/types.js";

function baseSecurity(overrides: Partial<SecurityAnalysis> = {}): SecurityAnalysis {
  return {
    csp: { present: false, raw: null, weaknesses: [] },
    clickjacking: { protected: true, hasXFrameOptions: true, hasCspFrameAncestors: false, conflicting: false },
    mixedContent: [],
    cookies: { observed: false, findings: [] },
    cors: { probeStatus: "checked", allowOriginHeader: null, allowCredentials: false, reflectsArbitraryOrigin: false, wildcardWithCredentialsAttempt: false },
    infoDisclosure: { probeStatus: "checked", checkedPaths: 10, findings: [] },
    debugExposure: { indicators: [] },
    redirectSecurity: { hostChain: ["example.com"], crossHostRedirect: false, httpProbe: { status: "not_applicable", redirectsToHttps: null } },
    crossOriginPolicies: { coop: "same-origin", corp: "same-origin", coep: "require-corp" },
    permissionsPolicy: { present: true, raw: "camera=(), microphone=()", wildcardFeatures: [] },
    secretExposure: { probeStatus: "checked", scannedLocations: 1, findings: [] },
    devUrlExposure: { findings: [] },
    httpMethods: { probeStatus: "checked", allowedMethods: ["GET", "HEAD"], riskyMethodsExposed: [] },
    hsts: { present: true, raw: "max-age=31536000; includeSubDomains", maxAgeSeconds: 31536000, includesSubDomains: true, maxAgeTooShort: false },
    referrerPolicy: { raw: "strict-origin-when-cross-origin", weak: false },
    insecureFormSubmission: { findings: [] },
    tlsCertificate: { probeStatus: "checked", protocol: "TLSv1.3", cipherName: "TLS_AES_256_GCM_SHA384", authorized: true, authorizationError: null, validTo: "Dec 31 23:59:59 2099 GMT", daysUntilExpiry: 9999, publicKeyBits: 2048, publicKeyIsRsa: true },
    caaRecords: { probeStatus: "checked", present: true, records: ["issue: letsencrypt.org"] },
    subresourceIntegrity: { findings: [] },
    verification: {
      https: "verified",
      headers: "verified",
      csp: "verified",
      clickjacking: "verified",
      cookies: "verified",
      cors: "verified",
      infoDisclosure: "verified",
      debugExposure: "verified",
      redirectSecurity: "not_applicable",
      crossOriginPolicies: "verified",
      secretExposure: "verified",
      devUrlExposure: "verified",
      permissionsPolicy: "verified",
      httpMethods: "verified",
      hsts: "verified",
      referrerPolicy: "verified",
      insecureFormSubmission: "verified",
      tlsCertificate: "verified",
      caaRecords: "verified",
      subresourceIntegrity: "verified",
      reverseTabnabbing: "verified",
    },
    ...overrides,
  };
}

const PAGE = "https://example.com/";

test("Permissions-Policy sensitive wildcard produces a medium issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const issues = detectAdvancedSecurityIssues(baseSecurity({
    permissionsPolicy: { present: true, raw: "camera=(*)", wildcardFeatures: ["camera"] },
  }), PAGE);
  const issue = issues.find((i) => i.title.includes("sensitive feature"));
  assert.ok(issue);
  assert.equal(issue?.severity, "medium");
});

test("reverse tabnabbing produces a low issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const issues = detectAdvancedSecurityIssues(baseSecurity({
    reverseTabnabbing: { findings: [{ url: "https://external.example", linkText: "Partner" }] },
  }), PAGE);
  const issue = issues.find((i) => i.title.includes("reverse tabnabbing"));
  assert.ok(issue);
  assert.equal(issue?.severity, "low");
});

test("a fully clean SecurityAnalysis produces zero issues", () => {
  resetAdvancedSecurityIssueIdCounter();
  const issues = detectAdvancedSecurityIssues(baseSecurity(), PAGE);
  assert.deepEqual(issues, []);
});

test("CSP weaknesses produce one aggregated issue, severity reflects the worst finding", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    csp: {
      present: true,
      raw: "script-src 'unsafe-inline'",
      weaknesses: [{ directive: "script-src", issue: "unsafe-inline", detail: "..." }],
    },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const cspIssue = issues.find((i) => i.title.includes("weak directives"));
  assert.ok(cspIssue);
  assert.equal(cspIssue!.severity, "high"); // unsafe-inline on script-src is high-impact
  assert.equal(cspIssue!.category, "security");
});

test("a low-impact-directive CSP weakness is not escalated to high", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    csp: {
      present: true,
      raw: "font-src *",
      weaknesses: [{ directive: "font-src", issue: "wildcard-source", detail: "..." }],
    },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const cspIssue = issues.find((i) => i.title.includes("weak directives"));
  assert.equal(cspIssue!.severity, "medium");
});

test("a CSP with neither default-src nor script-src is flagged high severity (no real script restriction)", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    csp: {
      present: true,
      raw: "img-src 'self'",
      weaknesses: [{ directive: "script-src", issue: "missing-script-restriction", detail: "..." }],
    },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const cspIssue = issues.find((i) => i.title.includes("weak directives"));
  assert.ok(cspIssue);
  assert.equal(cspIssue!.severity, "high");
});

test("clickjacking conflict produces a medium issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    clickjacking: { protected: true, hasXFrameOptions: true, hasCspFrameAncestors: true, conflicting: true },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("conflicting"));
  assert.ok(issue);
  assert.equal(issue!.severity, "medium");
});

test("font/media mixed content produces an issue distinct from the basic mixed-content check", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    mixedContent: [
      { resourceType: "font", url: "http://example.com/a.woff2", content: "passive" },
      { resourceType: "media", url: "http://example.com/b.mp4", content: "passive" },
    ],
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("font/media"));
  assert.ok(issue);
  assert.equal(issue!.severity, "medium");
});

test("many font/media mixed content findings escalate to high", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    mixedContent: [
      { resourceType: "font", url: "http://example.com/a.woff2", content: "passive" },
      { resourceType: "font", url: "http://example.com/b.woff2", content: "passive" },
      { resourceType: "media", url: "http://example.com/c.mp4", content: "passive" },
      { resourceType: "media", url: "http://example.com/d.mp4", content: "passive" },
    ],
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("font/media"));
  assert.equal(issue!.severity, "high");
});

test("mixed content of only script/img/iframe types (already covered elsewhere) produces no new issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    mixedContent: [{ resourceType: "script", url: "http://example.com/a.js", content: "active" }],
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("font/media")));
});

test("a sensitive-looking cookie missing Secure escalates to high", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    cookies: {
      observed: true,
      findings: [{ name: "sessionid", secure: false, httpOnly: true, sameSite: "Lax", looksSensitive: true }],
    },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("cookies"));
  assert.ok(issue);
  assert.equal(issue!.severity, "high");
});

test("a sensitive-looking cookie missing only HttpOnly (Secure set) is medium", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    cookies: {
      observed: true,
      findings: [{ name: "auth_token", secure: true, httpOnly: false, sameSite: "Lax", looksSensitive: true }],
    },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("cookies"));
  assert.equal(issue!.severity, "medium");
});

test("a well-configured cookie produces no issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    cookies: {
      observed: true,
      findings: [{ name: "sessionid", secure: true, httpOnly: true, sameSite: "Strict", looksSensitive: true }],
    },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.deepEqual(issues, []);
});

test("an overly broad cookie Domain attribute is flagged", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    cookies: {
      observed: true,
      findings: [{ name: "theme", secure: true, httpOnly: true, sameSite: "Lax", looksSensitive: false, domain: ".com", overlyBroadDomain: true }],
    },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("Domain attribute"));
  assert.ok(issue);
  assert.equal(issue!.severity, "medium");
});

test("a normally-scoped cookie Domain is not flagged", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    cookies: {
      observed: true,
      findings: [{ name: "theme", secure: true, httpOnly: true, sameSite: "Lax", looksSensitive: false, domain: ".example.com", overlyBroadDomain: false }],
    },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.deepEqual(issues, []);
});

test("no cross-origin isolation headers at all is a low-severity issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ crossOriginPolicies: { coop: null, corp: null, coep: null } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("COOP/CORP/COEP"));
  assert.ok(issue);
  assert.equal(issue!.severity, "low");
});

test("having at least one cross-origin isolation header set avoids the issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ crossOriginPolicies: { coop: "same-origin", corp: null, coep: null } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("COOP/CORP/COEP")));
});

test("missing Permissions-Policy is a low-severity hardening issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ permissionsPolicy: { present: false, raw: null, wildcardFeatures: [] } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("Permissions-Policy"));
  assert.ok(issue);
  assert.equal(issue!.severity, "low");
});

test("a present Permissions-Policy header avoids the issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ permissionsPolicy: { present: true, raw: "geolocation=()", wildcardFeatures: [] } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("Permissions-Policy")));
});

test("a risky HTTP method (TRACE) advertised in Allow is a medium-severity issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ httpMethods: { probeStatus: "checked", allowedMethods: ["GET", "HEAD", "TRACE"], riskyMethodsExposed: ["TRACE"] } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("TRACE"));
  assert.ok(issue);
  assert.equal(issue!.severity, "medium");
});

test("ordinary methods (GET/HEAD/POST/OPTIONS) produce no HTTP-methods issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ httpMethods: { probeStatus: "checked", allowedMethods: ["GET", "HEAD", "POST", "OPTIONS"], riskyMethodsExposed: [] } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("risky HTTP method")));
});

test("an HTTP-methods probe that couldn't run produces no issue (absence of evidence is not evidence of absence)", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ httpMethods: { probeStatus: "blocked", allowedMethods: [], riskyMethodsExposed: [] } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("risky HTTP method")));
});

test("HSTS with a too-short max-age is flagged low severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ hsts: { present: true, raw: "max-age=3600", maxAgeSeconds: 3600, includesSubDomains: false, maxAgeTooShort: true } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("max-age is too short"));
  assert.ok(issue);
  assert.equal(issue!.severity, "low");
});

test("HSTS with a good max-age produces no issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ hsts: { present: true, raw: "max-age=31536000", maxAgeSeconds: 31536000, includesSubDomains: false, maxAgeTooShort: false } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("max-age is too short")));
});

test("HSTS absent produces no quality issue here (absence itself is issues.ts's job)", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ hsts: { present: false, raw: null, maxAgeSeconds: null, includesSubDomains: false, maxAgeTooShort: false } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("max-age")));
});

test("Referrer-Policy: unsafe-url is flagged medium severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ referrerPolicy: { raw: "unsafe-url", weak: true } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("unsafe-url"));
  assert.ok(issue);
  assert.equal(issue!.severity, "medium");
});

test("Referrer-Policy: a legacy-but-not-dangerous value is NOT flagged (deliberately narrow)", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ referrerPolicy: { raw: "no-referrer-when-downgrade", weak: false } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("Referrer-Policy")));
});

test("a password form submitting to an insecure http:// action is critical severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    insecureFormSubmission: { findings: [{ formAction: "http://example.com/login", resolvedAction: "http://example.com/login" }] },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("password form"));
  assert.ok(issue);
  assert.equal(issue!.severity, "critical");
});

test("no insecure form findings produces no issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ insecureFormSubmission: { findings: [] } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("password form")));
});

test("a high-confidence secret finding is critical severity, and the redacted preview (not a raw value) is the only thing in evidence", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    secretExposure: {
      probeStatus: "checked",
      scannedLocations: 2,
      findings: [{ patternName: "AWS Access Key ID", location: "/app.js", redactedPreview: "AKIA************1234", confidence: "high" }],
    },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("AWS Access Key ID"));
  assert.ok(issue);
  assert.equal(issue!.severity, "critical");
  const evidenceText = JSON.stringify(issue!.evidence);
  assert.ok(evidenceText.includes("AKIA************1234"));
  assert.ok(!evidenceText.toLowerCase().includes("realsecretvalue"));
});

test("a medium-confidence secret finding is high severity, not critical", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    secretExposure: {
      probeStatus: "checked",
      scannedLocations: 1,
      findings: [{ patternName: "Hardcoded API key/secret assignment", location: "page HTML (inline content)", redactedPreview: "abcd************wxyz", confidence: "medium" }],
    },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("Hardcoded API key"));
  assert.equal(issue!.severity, "high");
});

test("secret findings are explicitly framed as PATTERN MATCH, never as a confirmed credential", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    secretExposure: {
      probeStatus: "checked",
      scannedLocations: 1,
      findings: [{ patternName: "AWS Access Key ID", location: "/app.js", redactedPreview: "AKIA************1234", confidence: "high" }],
    },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("AWS Access Key ID"));
  assert.ok(issue!.title.startsWith("PATTERN MATCH:"));
  assert.ok(issue!.whyItMatters.includes("PATTERN MATCH"));
  assert.ok(issue!.whyItMatters.includes("CONFIRMED ACTIVE CREDENTIAL"));
  // the title itself must not claim confirmation - only whyItMatters
  // contrasts the two terms for clarity
  assert.ok(!issue!.title.toUpperCase().includes("CONFIRMED"));
});

test("a localhost dev-URL reference is medium severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    devUrlExposure: { findings: [{ url: "http://localhost:3000/api", kind: "localhost", location: "page HTML (inline content)" }] },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("localhost/loopback"));
  assert.ok(issue);
  assert.equal(issue!.severity, "medium");
});

test("a staging-subdomain dev-URL reference is low severity, separate from the localhost issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    devUrlExposure: { findings: [{ url: "https://staging.example.com/api", kind: "staging-subdomain", location: "page HTML (inline content)" }] },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("staging/dev/test"));
  assert.ok(issue);
  assert.equal(issue!.severity, "low");
  assert.ok(!issues.some((i) => i.title.includes("localhost/loopback")));
});

test("CORS reflecting an arbitrary origin is high severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    cors: { probeStatus: "checked", allowOriginHeader: "https://insight-cors-probe.invalid", allowCredentials: false, reflectsArbitraryOrigin: true, wildcardWithCredentialsAttempt: false },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("reflects an arbitrary"));
  assert.ok(issue);
  assert.equal(issue!.severity, "high");
});

test("CORS wildcard + credentials is high severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    cors: { probeStatus: "checked", allowOriginHeader: "*", allowCredentials: true, reflectsArbitraryOrigin: false, wildcardWithCredentialsAttempt: true },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("Allow-Credentials"));
  assert.ok(issue);
  assert.equal(issue!.severity, "high");
});

test("plain CORS wildcard (no credentials) is low severity, informational", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    cors: { probeStatus: "checked", allowOriginHeader: "*", allowCredentials: false, reflectsArbitraryOrigin: false, wildcardWithCredentialsAttempt: false },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("any origin"));
  assert.ok(issue);
  assert.equal(issue!.severity, "low");
});

test("a CORS probe that could not be checked produces no CORS issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    cors: { probeStatus: "blocked", allowOriginHeader: null, allowCredentials: false, reflectsArbitraryOrigin: false, wildcardWithCredentialsAttempt: false },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.deepEqual(issues, []);
});

test("info disclosure: a .env-style exposure is critical", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    infoDisclosure: { probeStatus: "checked", checkedPaths: 10, findings: [{ path: "/.env", statusCode: 200, contentType: "text/plain", note: "..." }] },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("/.env"));
  assert.ok(issue);
  assert.equal(issue!.severity, "critical");
});

test("info disclosure: a directory listing is medium", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    infoDisclosure: { probeStatus: "checked", checkedPaths: 10, findings: [{ path: "/backup/", statusCode: 200, contentType: "text/html", note: "Directory listing appears to be enabled for this path." }] },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("/backup/"));
  assert.equal(issue!.severity, "medium");
});

test("info disclosure: an exposed source map is medium", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    infoDisclosure: { probeStatus: "checked", checkedPaths: 10, findings: [{ path: "/app.js.map", statusCode: 200, contentType: "application/json", note: "A JavaScript source map is publicly accessible and may expose original source code." }] },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("app.js.map"));
  assert.equal(issue!.severity, "medium");
});

test("info disclosure: a generic exposed path (not secret-like) is high", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    infoDisclosure: { probeStatus: "checked", checkedPaths: 10, findings: [{ path: "/.DS_Store", statusCode: 200, contentType: "application/octet-stream", note: "..." }] },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("DS_Store"));
  assert.equal(issue!.severity, "high");
});

test("debug exposure: a code-level indicator (stack trace) is high severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ debugExposure: { indicators: ["Node.js stack trace"] } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("Debug/error"));
  assert.ok(issue);
  assert.equal(issue!.severity, "high");
});

test("debug exposure: only a version-revealing header is low severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ debugExposure: { indicators: ['X-Powered-By header reveals a specific version ("PHP/8.1.2")'] } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("version information"));
  assert.ok(issue);
  assert.equal(issue!.severity, "low");
});

test("redirect security: cross-host redirect is a low, informational issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ redirectSecurity: { hostChain: ["example.com", "www.example.com"], crossHostRedirect: true, httpProbe: { status: "not_applicable", redirectsToHttps: null } } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("different host"));
  assert.ok(issue);
  assert.equal(issue!.severity, "low");
});

test("redirect security: plain HTTP not redirecting to HTTPS is high severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ redirectSecurity: { hostChain: ["example.com"], crossHostRedirect: false, httpProbe: { status: "checked", redirectsToHttps: false } } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("does not redirect to HTTPS"));
  assert.ok(issue);
  assert.equal(issue!.severity, "high");
});

test("redirect security: plain HTTP DOES redirect to HTTPS -> no issue", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({ redirectSecurity: { hostChain: ["example.com"], crossHostRedirect: false, httpProbe: { status: "checked", redirectsToHttps: true } } });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.deepEqual(issues, []);
});

test("every generated issue has a unique id and a priorityScore derived from severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    csp: { present: true, raw: "script-src 'unsafe-inline'", weaknesses: [{ directive: "script-src", issue: "unsafe-inline", detail: "..." }] },
    debugExposure: { indicators: ["Node.js stack trace"] },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(issues.length >= 2);
  const ids = issues.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  for (const issue of issues) {
    assert.ok(issue.id.startsWith("security-adv-"));
    assert.equal(issue.category, "security");
    assert.ok(issue.priorityScore > 0);
  }
});


test("TLS: a weak cipher (RC4) is flagged high severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    tlsCertificate: { probeStatus: "checked", protocol: "TLSv1.2", cipherName: "ECDHE-RSA-RC4-SHA", authorized: true, authorizationError: null, validTo: "Dec 31 23:59:59 2099 GMT", daysUntilExpiry: 9999, publicKeyBits: 2048, publicKeyIsRsa: true },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("Weak cipher suite"));
  assert.ok(issue);
  assert.equal(issue!.severity, "high");
});

test("TLS: a modern AEAD cipher (TLS 1.3) is NOT flagged as weak", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity(); // default fixture already uses TLS_AES_256_GCM_SHA384
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("Weak cipher suite")));
});

test("TLS: a modern AES-GCM (TLS 1.2) cipher is NOT flagged as weak (AES does not match the DES pattern)", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    tlsCertificate: { probeStatus: "checked", protocol: "TLSv1.2", cipherName: "ECDHE-RSA-AES128-GCM-SHA256", authorized: true, authorizationError: null, validTo: "Dec 31 23:59:59 2099 GMT", daysUntilExpiry: 9999, publicKeyBits: 2048, publicKeyIsRsa: true },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("Weak cipher suite")));
});

test("TLS: an undersized 1024-bit RSA key is flagged high severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    tlsCertificate: { probeStatus: "checked", protocol: "TLSv1.3", cipherName: "TLS_AES_256_GCM_SHA384", authorized: true, authorizationError: null, validTo: "Dec 31 23:59:59 2099 GMT", daysUntilExpiry: 9999, publicKeyBits: 1024, publicKeyIsRsa: true },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  const issue = issues.find((i) => i.title.includes("undersized RSA key"));
  assert.ok(issue);
  assert.equal(issue!.severity, "high");
  assert.ok(issue!.title.includes("1024"));
});

test("TLS: a 2048-bit RSA key is NOT flagged (meets the modern minimum)", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity(); // default fixture already uses 2048-bit RSA
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("undersized RSA key")));
});

test("TLS: a small key size on a NON-RSA key (e.g. EC) is deliberately NOT flagged - the threshold only applies when publicKeyIsRsa is true", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    // an EC P-256 key would report ~256 "bits" - laughably weak for RSA,
    // but actually strong for EC. publicKeyIsRsa: false must suppress
    // the check entirely rather than misapplying the RSA threshold.
    tlsCertificate: { probeStatus: "checked", protocol: "TLSv1.3", cipherName: "TLS_AES_256_GCM_SHA384", authorized: true, authorizationError: null, validTo: "Dec 31 23:59:59 2099 GMT", daysUntilExpiry: 9999, publicKeyBits: 256, publicKeyIsRsa: false },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("undersized RSA key")));
});

test("TLS: publicKeyBits null (unknown key type) is never flagged - no guessing", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    tlsCertificate: { probeStatus: "checked", protocol: "TLSv1.3", cipherName: "TLS_AES_256_GCM_SHA384", authorized: true, authorizationError: null, validTo: "Dec 31 23:59:59 2099 GMT", daysUntilExpiry: 9999, publicKeyBits: null, publicKeyIsRsa: false },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(!issues.some((i) => i.title.includes("undersized RSA key")));
});

test("every generated issue has a unique id and a priorityScore derived from severity", () => {
  resetAdvancedSecurityIssueIdCounter();
  const security = baseSecurity({
    csp: { present: true, raw: "script-src 'unsafe-inline'", weaknesses: [{ directive: "script-src", issue: "unsafe-inline", detail: "..." }] },
    debugExposure: { indicators: ["Node.js stack trace"] },
  });
  const issues = detectAdvancedSecurityIssues(security, PAGE);
  assert.ok(issues.length >= 2);
  const ids = issues.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  for (const issue of issues) {
    assert.ok(issue.id.startsWith("security-adv-"));
    assert.equal(issue.category, "security");
    assert.ok(issue.priorityScore > 0);
  }
});
