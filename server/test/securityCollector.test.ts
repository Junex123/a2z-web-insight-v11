import assert from "node:assert/strict";
import { test } from "node:test";
import * as cheerio from "cheerio";
import {
  analyzeClickjacking,
  analyzeCookies,
  analyzeCrossOriginPolicies,
  analyzeCsp,
  analyzeDebugExposure,
  analyzeHsts,
  analyzeInsecureFormSubmission,
  analyzeMixedContent,
  analyzePermissionsPolicy,
  analyzeRedirectChain,
  analyzeReverseTabnabbing,
  analyzeReferrerPolicyQuality,
  parseResources,
  scanForDevUrls,
  scanForSecrets,
} from "../src/collectors/securityCollector.js";
import type { FetchResult } from "../src/types.js";

// =====================================================================
// CSP quality
// =====================================================================

test("CSP: no header -> present false, no weaknesses", () => {
  const result = analyzeCsp({});
  assert.equal(result.present, false);
  assert.equal(result.raw, null);
  assert.deepEqual(result.weaknesses, []);
});

test("CSP: a tight policy with only 'self' has no weaknesses", () => {
  const result = analyzeCsp({ "content-security-policy": "default-src 'self'" });
  assert.equal(result.present, true);
  assert.deepEqual(result.weaknesses, []);
});

test("CSP: unsafe-inline is flagged on the directive it appears in", () => {
  const result = analyzeCsp({ "content-security-policy": "script-src 'self' 'unsafe-inline'" });
  assert.ok(result.weaknesses.some((w) => w.directive === "script-src" && w.issue === "unsafe-inline"));
});

test("CSP: unsafe-eval is flagged", () => {
  const result = analyzeCsp({ "content-security-policy": "script-src 'unsafe-eval'" });
  assert.ok(result.weaknesses.some((w) => w.issue === "unsafe-eval"));
});

test("CSP: wildcard source is flagged", () => {
  const result = analyzeCsp({ "content-security-policy": "default-src *" });
  assert.ok(result.weaknesses.some((w) => w.issue === "wildcard-source"));
});

test("CSP: insecure http: source is flagged", () => {
  const result = analyzeCsp({ "content-security-policy": "img-src http://example.com" });
  assert.ok(result.weaknesses.some((w) => w.directive === "img-src" && w.issue === "insecure-http-source"));
});

test("CSP: upgrade-insecure-requests alongside an explicit http: source is contradictory", () => {
  const result = analyzeCsp({ "content-security-policy": "upgrade-insecure-requests; img-src http://example.com" });
  assert.ok(result.weaknesses.some((w) => w.issue === "contradictory-upgrade-insecure"));
});

test("CSP: upgrade-insecure-requests alone (no http: sources) is not flagged as contradictory", () => {
  const result = analyzeCsp({ "content-security-policy": "upgrade-insecure-requests; default-src 'self'" });
  assert.ok(!result.weaknesses.some((w) => w.issue === "contradictory-upgrade-insecure"));
});

test("CSP: a policy with no default-src or script-src is flagged as providing no script restriction", () => {
  const result = analyzeCsp({ "content-security-policy": "img-src 'self'" });
  assert.ok(result.weaknesses.some((w) => w.issue === "missing-script-restriction"));
});

test("CSP: default-src alone (no explicit script-src) is NOT flagged - default-src covers scripts by CSP fallback", () => {
  const result = analyzeCsp({ "content-security-policy": "default-src 'self'" });
  assert.ok(!result.weaknesses.some((w) => w.issue === "missing-script-restriction"));
});

test("CSP: script-src alone (no default-src) is NOT flagged", () => {
  const result = analyzeCsp({ "content-security-policy": "script-src 'self'" });
  assert.ok(!result.weaknesses.some((w) => w.issue === "missing-script-restriction"));
});

// =====================================================================
// Clickjacking conflict detection
// =====================================================================

test("clickjacking: neither header present -> not protected", () => {
  const result = analyzeClickjacking({});
  assert.equal(result.protected, false);
  assert.equal(result.conflicting, false);
});

test("clickjacking: only X-Frame-Options -> protected, not conflicting", () => {
  const result = analyzeClickjacking({ "x-frame-options": "SAMEORIGIN" });
  assert.equal(result.protected, true);
  assert.equal(result.conflicting, false);
});

test("clickjacking: XFO DENY + frame-ancestors 'self' conflict (deny vs allowing self)", () => {
  const result = analyzeClickjacking({
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'self'",
  });
  assert.equal(result.conflicting, true);
});

test("clickjacking: XFO DENY + frame-ancestors 'none' agree, no conflict", () => {
  const result = analyzeClickjacking({
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
  });
  assert.equal(result.conflicting, false);
});

test("clickjacking: XFO SAMEORIGIN + frame-ancestors 'self' agree, no conflict", () => {
  const result = analyzeClickjacking({
    "x-frame-options": "SAMEORIGIN",
    "content-security-policy": "frame-ancestors 'self'",
  });
  assert.equal(result.conflicting, false);
});

test("clickjacking: deprecated ALLOW-FROM value always counts as conflicting when frame-ancestors is also set", () => {
  const result = analyzeClickjacking({
    "x-frame-options": "ALLOW-FROM https://example.com",
    "content-security-policy": "frame-ancestors 'self'",
  });
  assert.equal(result.conflicting, true);
});

// =====================================================================
// Cookies - safe metadata only
// =====================================================================

test("cookies: no Set-Cookie headers -> observed false", () => {
  const result = analyzeCookies(undefined);
  assert.equal(result.observed, false);
  assert.deepEqual(result.findings, []);
});

test("cookies: a sensitive-looking cookie missing Secure/HttpOnly/SameSite is flagged as such", () => {
  const result = analyzeCookies(["sessionid=s3cr3t-value-not-checked; Path=/"]);
  assert.equal(result.observed, true);
  assert.equal(result.findings.length, 1);
  const [c] = result.findings;
  assert.equal(c.name, "sessionid");
  assert.equal(c.secure, false);
  assert.equal(c.httpOnly, false);
  assert.equal(c.sameSite, "not set");
  assert.equal(c.looksSensitive, true);
});

test("cookies: a well-configured non-sensitive-named cookie is parsed correctly", () => {
  const result = analyzeCookies(["theme=dark; Secure; HttpOnly; SameSite=Strict"]);
  const [c] = result.findings;
  assert.equal(c.name, "theme");
  assert.equal(c.secure, true);
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, "Strict");
  assert.equal(c.looksSensitive, false);
});

test("cookies: Domain and Path attributes are captured as safe metadata", () => {
  const result = analyzeCookies(["theme=dark; Domain=.example.com; Path=/app"]);
  const [c] = result.findings;
  assert.equal(c.domain, ".example.com");
  assert.equal(c.path, "/app");
  assert.equal(c.overlyBroadDomain, false);
});

test("cookies: an overly broad single-label Domain is flagged", () => {
  const result = analyzeCookies(["theme=dark; Domain=.com"]);
  const [c] = result.findings;
  assert.equal(c.overlyBroadDomain, true);
});

test("cookies: no Domain attribute at all is not flagged as overly broad", () => {
  const result = analyzeCookies(["theme=dark"]);
  const [c] = result.findings;
  assert.equal(c.domain, null);
  assert.equal(c.overlyBroadDomain, false);
});

// ---------------------------------------------------------------------
// False-positive guards - explicit cases the sensitive-cookie heuristic
// and secret patterns are deliberately designed NOT to flag.
// ---------------------------------------------------------------------

test("false positive guard: a cookie merely containing 'user' in its name is NOT flagged sensitive", () => {
  const result = analyzeCookies(["user_locale=en-US"]);
  assert.equal(result.findings[0].looksSensitive, false);
});

test("false positive guard: a cookie merely containing 'account' in its name is NOT flagged sensitive", () => {
  const result = analyzeCookies(["account_banner_dismissed=1"]);
  assert.equal(result.findings[0].looksSensitive, false);
});

test("false positive guard: cookies with genuinely sensitive-looking names are still flagged", () => {
  assert.equal(analyzeCookies(["auth_token=x"]).findings[0].looksSensitive, true);
  assert.equal(analyzeCookies(["session_id=x"]).findings[0].looksSensitive, true);
  assert.equal(analyzeCookies(["csrf_token=x"]).findings[0].looksSensitive, true);
});

// =====================================================================
// Cross-origin isolation headers
// =====================================================================

test("cross-origin policies: none set", () => {
  const result = analyzeCrossOriginPolicies({});
  assert.deepEqual(result, { coop: null, corp: null, coep: null });
});

test("cross-origin policies: observed values are passed through as-is", () => {
  const result = analyzeCrossOriginPolicies({
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-site",
    "cross-origin-embedder-policy": "require-corp",
  });
  assert.equal(result.coop, "same-origin");
  assert.equal(result.corp, "same-site");
  assert.equal(result.coep, "require-corp");
});

// =====================================================================
// Permissions-Policy
// =====================================================================

test("permissions policy: not present", () => {
  const result = analyzePermissionsPolicy({});
  assert.deepEqual(result, { present: false, raw: null, wildcardFeatures: [] });
});

test("permissions policy: present with observed value passed through", () => {
  const result = analyzePermissionsPolicy({ "permissions-policy": "camera=(), microphone=()" });
  assert.deepEqual(result, { present: true, raw: "camera=(), microphone=()", wildcardFeatures: [] });
});

test("permissions policy: sensitive wildcard features are detected", () => {
  const result = analyzePermissionsPolicy({ "permissions-policy": "camera=(*), microphone=(*), geolocation=(self)" });
  assert.deepEqual(result.wildcardFeatures, ["camera", "microphone"]);
});

test("permissions policy: non-sensitive wildcard is not flagged", () => {
  const result = analyzePermissionsPolicy({ "permissions-policy": "fullscreen=(*)" });
  assert.deepEqual(result.wildcardFeatures, []);
});

test("reverse tabnabbing: unsafe target blank links are collected", () => {
  const $ = cheerio.load('<a target="_blank" href="https://example.com">Partner</a><a target="_blank" rel="noopener" href="https://safe.example">Safe</a>');
  const result = analyzeReverseTabnabbing($);
  assert.deepEqual(result.findings, [{ url: "https://example.com", linkText: "Partner" }]);
});

// =====================================================================
// HSTS quality
// =====================================================================

test("HSTS: not present", () => {
  const result = analyzeHsts({});
  assert.deepEqual(result, { present: false, raw: null, maxAgeSeconds: null, includesSubDomains: false, maxAgeTooShort: false });
});

test("HSTS: a long max-age with includeSubDomains is not flagged too short", () => {
  const result = analyzeHsts({ "strict-transport-security": "max-age=31536000; includeSubDomains" });
  assert.equal(result.present, true);
  assert.equal(result.maxAgeSeconds, 31536000);
  assert.equal(result.includesSubDomains, true);
  assert.equal(result.maxAgeTooShort, false);
});

test("HSTS: a short max-age is flagged too short", () => {
  const result = analyzeHsts({ "strict-transport-security": "max-age=3600" });
  assert.equal(result.maxAgeSeconds, 3600);
  assert.equal(result.maxAgeTooShort, true);
  assert.equal(result.includesSubDomains, false);
});

test("HSTS: max-age=0 (explicitly disabling HSTS) is flagged too short", () => {
  const result = analyzeHsts({ "strict-transport-security": "max-age=0" });
  assert.equal(result.maxAgeSeconds, 0);
  assert.equal(result.maxAgeTooShort, true);
});

test("HSTS: a malformed header with no parseable max-age is not flagged too short (no false claim without evidence)", () => {
  const result = analyzeHsts({ "strict-transport-security": "includeSubDomains" });
  assert.equal(result.present, true);
  assert.equal(result.maxAgeSeconds, null);
  assert.equal(result.maxAgeTooShort, false);
});

// =====================================================================
// Referrer-Policy quality
// =====================================================================

test("referrer policy: unsafe-url is flagged weak", () => {
  const result = analyzeReferrerPolicyQuality({ "referrer-policy": "unsafe-url" });
  assert.equal(result.weak, true);
});

test("referrer policy: strict-origin-when-cross-origin is not flagged", () => {
  const result = analyzeReferrerPolicyQuality({ "referrer-policy": "strict-origin-when-cross-origin" });
  assert.equal(result.weak, false);
});

test("referrer policy: a legacy value (no-referrer-when-downgrade) is deliberately NOT flagged weak", () => {
  const result = analyzeReferrerPolicyQuality({ "referrer-policy": "no-referrer-when-downgrade" });
  assert.equal(result.weak, false);
});

test("referrer policy: absent is not flagged weak here (absence is issues.ts's job)", () => {
  const result = analyzeReferrerPolicyQuality({});
  assert.equal(result.raw, null);
  assert.equal(result.weak, false);
});

// =====================================================================
// Insecure password-form submission
// =====================================================================

test("insecure form: a password form with an explicit http:// action on an https page is flagged", () => {
  const html = `<html><body><form action="http://example.com/login"><input type="password"></form></body></html>`;
  const $ = cheerio.load(html);
  const result = analyzeInsecureFormSubmission($, "https://example.com/account", true);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].formAction, "http://example.com/login");
});

test("insecure form: a password form with a relative action is NOT flagged (inherits page's https)", () => {
  const html = `<html><body><form action="/login"><input type="password"></form></body></html>`;
  const $ = cheerio.load(html);
  const result = analyzeInsecureFormSubmission($, "https://example.com/account", true);
  assert.deepEqual(result.findings, []);
});

test("insecure form: a password form with NO action attribute is NOT flagged (submits to current https page)", () => {
  const html = `<html><body><form><input type="password"></form></body></html>`;
  const $ = cheerio.load(html);
  const result = analyzeInsecureFormSubmission($, "https://example.com/account", true);
  assert.deepEqual(result.findings, []);
});

test("insecure form: a form with an http:// action but NO password field is NOT flagged", () => {
  const html = `<html><body><form action="http://example.com/search"><input type="text"></form></body></html>`;
  const $ = cheerio.load(html);
  const result = analyzeInsecureFormSubmission($, "https://example.com/account", true);
  assert.deepEqual(result.findings, []);
});

test("insecure form: nothing is flagged when the page itself is not https (already covered by the HTTPS check)", () => {
  const html = `<html><body><form action="http://example.com/login"><input type="password"></form></body></html>`;
  const $ = cheerio.load(html);
  const result = analyzeInsecureFormSubmission($, "http://example.com/account", false);
  assert.deepEqual(result.findings, []);
});

test("insecure form: an https:// action is NOT flagged", () => {
  const html = `<html><body><form action="https://example.com/login"><input type="password"></form></body></html>`;
  const $ = cheerio.load(html);
  const result = analyzeInsecureFormSubmission($, "https://example.com/account", true);
  assert.deepEqual(result.findings, []);
});

// =====================================================================
// Secret-pattern detection (with redaction)
// =====================================================================

test("secret scanning: an AWS access key ID is detected and redacted", () => {
  const findings = scanForSecrets("const key = 'AKIAABCDEFGHIJKLMNOP';", "test.js");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].patternName, "AWS Access Key ID");
  assert.equal(findings[0].confidence, "high");
  // the raw secret must never appear in the output - only a redacted preview
  assert.ok(!findings[0].redactedPreview.includes("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(findings[0].redactedPreview.startsWith("AKIA"));
  assert.ok(findings[0].redactedPreview.includes("*"));
});

test("secret scanning: a generic hardcoded API key assignment is detected at medium confidence", () => {
  const findings = scanForSecrets(`const apiKey = "abcdefghij1234567890XYZ";`, "test.js");
  assert.ok(findings.some((f) => f.patternName.includes("Hardcoded API key") && f.confidence === "medium"));
});

test("secret scanning: ordinary code with no secret-shaped strings produces no findings", () => {
  const findings = scanForSecrets(`function add(a, b) { return a + b; }`, "test.js");
  assert.deepEqual(findings, []);
});

test("false positive guard: an obvious short placeholder value is not flagged as a secret", () => {
  // "changeme" is well under the generic pattern's 20-char minimum -
  // exactly the kind of placeholder text the length threshold exists to
  // exclude.
  const findings = scanForSecrets(`const apiKey = "changeme";`, "test.js");
  assert.deepEqual(findings, []);
});

test("false positive guard: a variable name that merely contains 'key' (not api_key/secret_key/etc) is not flagged", () => {
  const findings = scanForSecrets(`const monkeyName = "abcdefghijklmnopqrstuvwxyz";`, "test.js");
  assert.deepEqual(findings, []);
});

test("secret scanning: a private key block is detected", () => {
  const findings = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----", "test.js");
  assert.ok(findings.some((f) => f.patternName === "Private Key Block"));
});

test("secret scanning: the location passed in is recorded verbatim", () => {
  const findings = scanForSecrets("const key = 'AKIAABCDEFGHIJKLMNOP';", "page HTML (inline content)");
  assert.equal(findings[0].location, "page HTML (inline content)");
});

// =====================================================================
// Dev/staging URL detection
// =====================================================================

test("dev URL scanning: a localhost URL with a port is detected", () => {
  const findings = scanForDevUrls(`fetch("http://localhost:3000/api/users")`, "test.js");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "localhost");
  assert.equal(findings[0].url, "http://localhost:3000/api/users");
});

test("dev URL scanning: a loopback IP URL is detected", () => {
  const findings = scanForDevUrls(`const base = "http://127.0.0.1:8080";`, "test.js");
  assert.ok(findings.some((f) => f.kind === "loopback-ip"));
});

test("dev URL scanning: a staging subdomain is detected", () => {
  const findings = scanForDevUrls(`fetch("https://staging.example.com/api")`, "test.js");
  assert.ok(findings.some((f) => f.kind === "staging-subdomain"));
});

test("dev URL scanning: a normal production URL produces no findings", () => {
  const findings = scanForDevUrls(`fetch("https://api.example.com/v1/users")`, "test.js");
  assert.deepEqual(findings, []);
});

// =====================================================================
// Debug / development exposure
// =====================================================================

test("debug exposure: a Node stack trace in the body is detected", () => {
  const body = "Internal error\n    at Object.<anonymous> (/app/server.js:42:13)\n    at Module._compile (node:internal:1234:5)";
  const result = analyzeDebugExposure(body, {});
  assert.ok(result.indicators.includes("Node.js stack trace"));
});

test("debug exposure: X-Powered-By with a version number is flagged", () => {
  const result = analyzeDebugExposure("<html></html>", { "x-powered-by": "PHP/8.1.2" });
  assert.ok(result.indicators.some((i) => i.includes("X-Powered-By")));
});

test("debug exposure: bare X-Powered-By with no version is not flagged", () => {
  const result = analyzeDebugExposure("<html></html>", { "x-powered-by": "Express" });
  assert.equal(result.indicators.length, 0);
});

test("debug exposure: a clean page produces no indicators", () => {
  const result = analyzeDebugExposure("<html><body>All good here.</body></html>", { server: "nginx" });
  assert.deepEqual(result.indicators, []);
});

// =====================================================================
// Redirect chain / host analysis
// =====================================================================

function baseFetch(overrides: Partial<FetchResult> = {}): FetchResult {
  return {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    statusCode: 200,
    httpsUsed: true,
    redirected: false,
    redirectCount: 0,
    timing: { approxTtfbMs: 100, totalDownloadMs: 150 },
    headers: {},
    bodyBytes: 100,
    bodyText: "<html></html>",
    contentType: "text/html",
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("redirect chain: same-host redirect chain -> crossHostRedirect false", () => {
  const result = analyzeRedirectChain(
    baseFetch({ redirectChain: ["https://example.com/old", "https://example.com/new"] }),
  );
  assert.equal(result.crossHostRedirect, false);
  assert.deepEqual(result.hostChain, ["example.com"]);
});

test("redirect chain: cross-host redirect chain -> crossHostRedirect true", () => {
  const result = analyzeRedirectChain(
    baseFetch({ redirectChain: ["https://example.com/", "https://www.example.com/"] }),
  );
  assert.equal(result.crossHostRedirect, true);
  assert.deepEqual(result.hostChain, ["example.com", "www.example.com"]);
});

test("redirect chain: missing redirectChain falls back to requested/final URL", () => {
  const result = analyzeRedirectChain(
    baseFetch({ requestedUrl: "https://a.example.com/", finalUrl: "https://b.example.com/", redirectChain: undefined }),
  );
  assert.equal(result.crossHostRedirect, true);
});

// =====================================================================
// Mixed content (extended resource types)
// =====================================================================

test("mixed content: collects insecure font/media resources on an https page", () => {
  const html = `<html><head>
    <link rel="preload" as="font" href="http://fonts.example.com/a.woff2">
  </head><body>
    <video src="http://media.example.com/clip.mp4"></video>
  </body></html>`;
  const $ = cheerio.load(html);
  const { resourceRefs } = parseResources($);
  const findings = analyzeMixedContent(resourceRefs, true);
  assert.ok(findings.some((f) => f.resourceType === "font"));
  assert.ok(findings.some((f) => f.resourceType === "media"));
});

test("mixed content: fonts and media are classified as passive", () => {
  const html = `<html><head>
    <link rel="preload" as="font" href="http://fonts.example.com/a.woff2">
  </head><body>
    <video src="http://media.example.com/clip.mp4"></video>
  </body></html>`;
  const $ = cheerio.load(html);
  const { resourceRefs } = parseResources($);
  const findings = analyzeMixedContent(resourceRefs, true);
  for (const f of findings) assert.equal(f.content, "passive");
});

test("mixed content: scripts and iframes are classified as active", () => {
  const html = `<html><body>
    <script src="http://scripts.example.com/a.js"></script>
    <iframe src="http://frames.example.com/embed"></iframe>
  </body></html>`;
  const $ = cheerio.load(html);
  const { resourceRefs } = parseResources($);
  const findings = analyzeMixedContent(resourceRefs, true);
  const script = findings.find((f) => f.resourceType === "script");
  const iframe = findings.find((f) => f.resourceType === "iframe");
  assert.equal(script?.content, "active");
  assert.equal(iframe?.content, "active");
});

test("mixed content: images/stylesheets are classified as passive (same as fonts/media)", () => {
  const html = `<html><head>
    <link rel="stylesheet" href="http://styles.example.com/a.css">
  </head><body>
    <img src="http://images.example.com/a.png">
  </body></html>`;
  const $ = cheerio.load(html);
  const { resourceRefs } = parseResources($);
  const findings = analyzeMixedContent(resourceRefs, true);
  for (const f of findings) assert.equal(f.content, "passive");
});

test("mixed content: nothing reported when the page itself is not https", () => {
  const html = `<html><body><img src="http://example.com/a.png"></body></html>`;
  const $ = cheerio.load(html);
  const { resourceRefs } = parseResources($);
  const findings = analyzeMixedContent(resourceRefs, false);
  assert.deepEqual(findings, []);
});
