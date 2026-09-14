import * as cheerio from "cheerio";
import { lookup as dnsLookup, resolveCaa as dnsResolveCaa } from "node:dns/promises";
import { setTimeout as sleep } from "node:timers/promises";
import tls from "node:tls";
import { assertHostAllowed, parseAndValidateUrl } from "./httpCollector.js";
import type {
  CookieFinding,
  CookieSameSite,
  CspFinding,
  DevUrlFinding,
  FetchResult,
  FormSecurityFinding,
  InfoDisclosureFinding,
  MixedContentResourceType,
  SecretFinding,
  SecurityAnalysis,
  SriFinding,
  TabnabbingFinding,
  VerificationStatus,
} from "../types.js";

/**
 * FULL-WEBSITE SECURITY VERIFICATION - fact gathering (MEASURE step).
 *
 * This is a defensive PRE-LIVE verification aid, NOT a penetration-testing
 * tool: nothing here exploits anything, brute-forces credentials, submits
 * forms, or performs intrusive testing. Every field this module produces
 * is either:
 *   (a) a deterministic classification of data already fetched by
 *       httpCollector.ts (CSP parsing, cookie attribute parsing, mixed
 *       content, debug-exposure pattern matching), or
 *   (b) the result of a small, bounded set of additional READ-ONLY GET
 *       requests to the SAME origin already being scanned, run through
 *       the exact same SSRF guard (assertHostAllowed) as every other
 *       request this app makes - never a second, weaker fetch path.
 *
 * Every additional network call this module makes:
 *   - targets only the same host as the page already being scanned (a
 *     small fixed list of same-origin paths, or same-origin script URLs
 *     observed in the actual HTML - never arbitrary/guessed hosts),
 *   - is bounded (a small fixed path list, capped source-map candidates,
 *     one CORS probe, one plain-http probe),
 *   - has its own short timeout and never follows more than one redirect
 *     hop (a redirect just means "not directly exposed here" for these
 *     checks - we don't need the full hardened multi-hop loop that
 *     collectHttp uses for the real page fetch),
 *   - never throws upward - any failure degrades to "couldn't verify"
 *     evidence rather than crashing or skewing the rest of the scan.
 */

const PROBE_TIMEOUT_MS = Number(process.env.SECURITY_PROBE_TIMEOUT_MS) || 5000;
const MAX_PROBE_BODY_BYTES = 65_536; // small cap - these probes only need status/headers/a short body sample

// =====================================================================
// CSP quality
// =====================================================================

export function analyzeCsp(headers: Record<string, string>): SecurityAnalysis["csp"] {
  const raw = headers["content-security-policy"] ?? null;
  if (!raw) return { present: false, raw: null, weaknesses: [] };

  const weaknesses: CspFinding[] = [];
  const bySources = new Map<string, string[]>();

  for (const rawDirective of raw.split(";")) {
    const tokens = rawDirective.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    const sources = tokens.slice(1);
    bySources.set(name, sources);

    for (const src of sources) {
      const lsrc = src.toLowerCase();
      if (lsrc === "'unsafe-inline'") {
        weaknesses.push({
          directive: name,
          issue: "unsafe-inline",
          detail: `${name} allows 'unsafe-inline', which permits inline scripts/styles and significantly weakens CSP's XSS protection for this directive.`,
        });
      } else if (lsrc === "'unsafe-eval'") {
        weaknesses.push({
          directive: name,
          issue: "unsafe-eval",
          detail: `${name} allows 'unsafe-eval', permitting eval()/Function()-style dynamic code execution.`,
        });
      } else if (lsrc === "*") {
        weaknesses.push({
          directive: name,
          issue: "wildcard-source",
          detail: `${name} allows '*' (any origin), removing any real source restriction for this directive.`,
        });
      } else if (lsrc.startsWith("http:")) {
        weaknesses.push({
          directive: name,
          issue: "insecure-http-source",
          detail: `${name} explicitly allows an insecure http:// source (${src}), which can be tampered with in transit.`,
        });
      }
    }
  }

  // Obviously contradictory directives: upgrade-insecure-requests (browser
  // rewrites all http:// sub-resource requests to https://) alongside a
  // directive that still explicitly whitelists an http:// source - the
  // whitelisted source becomes unreachable AND the policy reads as
  // internally inconsistent.
  if (bySources.has("upgrade-insecure-requests")) {
    for (const [name, sources] of bySources) {
      if (name === "upgrade-insecure-requests") continue;
      if (sources.some((s) => s.toLowerCase().startsWith("http:"))) {
        weaknesses.push({
          directive: name,
          issue: "contradictory-upgrade-insecure",
          detail: `CSP sets upgrade-insecure-requests but ${name} still explicitly lists an insecure http:// source - contradictory, and the source is effectively unreachable anyway.`,
        });
      }
    }
  }

  // A CSP that restricts NEITHER default-src NOR script-src restricts
  // nothing about script execution at all - "present" but provides no
  // real XSS mitigation. This is worth flagging distinctly from the
  // per-source weaknesses above (a CSP can have zero of those and still
  // fail this check, e.g. `Content-Security-Policy: img-src 'self'`).
  if (!bySources.has("default-src") && !bySources.has("script-src")) {
    weaknesses.push({
      directive: "script-src",
      issue: "missing-script-restriction",
      detail: "The policy has no default-src or script-src directive, so it does not restrict script execution at all - it provides no real XSS mitigation despite being present.",
    });
  }

  return { present: true, raw, weaknesses: weaknesses.slice(0, 15) };
}

// =====================================================================
// Clickjacking protection quality (presence is already checked in
// analysis/issues.ts - this adds the CONFLICT check that requires
// looking at both headers together)
// =====================================================================

export function analyzeClickjacking(headers: Record<string, string>): SecurityAnalysis["clickjacking"] {
  const xfoRaw = headers["x-frame-options"];
  const csp = headers["content-security-policy"] ?? "";
  const faMatch = /frame-ancestors\s+([^;]+)/i.exec(csp);

  const hasXFrameOptions = !!xfoRaw;
  const hasCspFrameAncestors = !!faMatch;

  let conflicting = false;
  if (hasXFrameOptions && hasCspFrameAncestors) {
    const xfo = xfoRaw!.trim().toLowerCase();
    const fa = faMatch![1].trim().toLowerCase();
    const faIsNone = fa === "'none'";
    const faIsSelf = fa === "'self'";
    // frame-ancestors wins in browsers that support it, but a real
    // authoring inconsistency (the two headers clearly disagree, likely
    // set by different, uncoordinated mechanisms) is still worth
    // surfacing so it can be cleaned up rather than left to chance for
    // any browser/proxy that only honors one of the two.
    if (xfo === "deny" && !faIsNone) conflicting = true;
    else if (xfo === "sameorigin" && !faIsNone && !faIsSelf) conflicting = true;
    else if (xfo !== "deny" && xfo !== "sameorigin") conflicting = true; // e.g. deprecated ALLOW-FROM
  }

  return {
    protected: hasXFrameOptions || hasCspFrameAncestors,
    hasXFrameOptions,
    hasCspFrameAncestors,
    conflicting,
  };
}

// =====================================================================
// Resource parsing (one cheerio pass, shared by mixed-content + the
// same-origin script list used for source-map probing)
// =====================================================================

interface ResourceRef {
  type: MixedContentResourceType;
  url: string;
}

export function parseResources($: cheerio.CheerioAPI): { scriptSrcs: string[]; resourceRefs: ResourceRef[] } {
  const scriptSrcs: string[] = [];
  const resourceRefs: ResourceRef[] = [];
  const add = (type: MixedContentResourceType, url: string | undefined) => {
    if (url) resourceRefs.push({ type, url });
  };

  $("script[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) scriptSrcs.push(src);
    add("script", src);
  });
  $('link[rel="stylesheet"]').each((_, el) => add("stylesheet", $(el).attr("href")));
  $("img[src]").each((_, el) => add("image", $(el).attr("src")));
  $("video[poster]").each((_, el) => add("image", $(el).attr("poster")));
  $("iframe[src]").each((_, el) => add("iframe", $(el).attr("src")));
  $('link[rel="preload"][as="font"], link[rel="font"]').each((_, el) => add("font", $(el).attr("href")));
  $("video[src], audio[src], source[src], embed[src]").each((_, el) => add("media", $(el).attr("src")));

  return { scriptSrcs, resourceRefs };
}

/**
 * Extends the existing issues.ts mixed-content check (img/script/link/
 * iframe) with the resource types the task brief specifically calls out
 * that it doesn't yet cover: fonts and media. Scripts/stylesheets/
 * images/iframes are collected here too (needed for a complete same-
 * page picture) but analysis/securityIssues.ts deliberately only turns
 * the font/media subset into a NEW issue, to avoid double-reporting the
 * exact same evidence issues.ts already surfaces - see that file.
 *
 * Each finding is also classified "active" vs "passive" (see
 * MixedContentFinding's doc in types.ts) - a static classification of
 * the resource TYPE, not a browser-observed fact about whether it was
 * actually blocked. Insight Web has no browser/runtime execution layer
 * here, so it cannot distinguish "the browser blocked this" from
 * "this loaded" the way real DevTools/CDP evidence would - this
 * classification is deliberately scoped to what a static HTML fetch can
 * actually support.
 */
const ACTIVE_MIXED_CONTENT_TYPES = new Set<MixedContentResourceType>(["script", "iframe"]);

export function analyzeMixedContent(resourceRefs: ResourceRef[], pageIsHttps: boolean): SecurityAnalysis["mixedContent"] {
  if (!pageIsHttps) return [];
  const seen = new Set<string>();
  const findings: SecurityAnalysis["mixedContent"] = [];
  for (const ref of resourceRefs) {
    if (!ref.url.startsWith("http://")) continue;
    const key = `${ref.type}:${ref.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ resourceType: ref.type, url: ref.url, content: ACTIVE_MIXED_CONTENT_TYPES.has(ref.type) ? "active" : "passive" });
  }
  return findings.slice(0, 25);
}

// =====================================================================
// Cross-origin isolation headers - observed values only, no probe.
// =====================================================================

export function analyzeCrossOriginPolicies(headers: Record<string, string>): SecurityAnalysis["crossOriginPolicies"] {
  return {
    coop: headers["cross-origin-opener-policy"] ?? null,
    corp: headers["cross-origin-resource-policy"] ?? null,
    coep: headers["cross-origin-embedder-policy"] ?? null,
  };
}

// =====================================================================
// Permissions-Policy - observed value only, no probe.
// =====================================================================

const SENSITIVE_PERMISSIONS_FEATURES = new Set(["camera", "microphone", "geolocation", "payment", "usb"]);

export function analyzePermissionsPolicy(headers: Record<string, string>): SecurityAnalysis["permissionsPolicy"] {
  const raw = headers["permissions-policy"] ?? null;
  if (raw === null) return { present: false, raw: null, wildcardFeatures: [] };
  const wildcardFeatures: string[] = [];
  for (const segment of raw.split(",")) {
    const match = /^\s*([a-z-]+)\s*=\s*\(([^)]*)\)/i.exec(segment);
    if (!match) continue;
    const feature = match[1].toLowerCase();
    if (!SENSITIVE_PERMISSIONS_FEATURES.has(feature)) continue;
    const allowlist = match[2];
    if (/(^|\s)\*(\s|$)/.test(allowlist)) wildcardFeatures.push(feature);
  }
  return { present: true, raw, wildcardFeatures };
}

// =====================================================================
// HSTS quality - presence alone is already checked in analysis/issues.ts;
// this is the max-age/includeSubDomains value analysis (same presence-
// vs-quality split as CSP above). Pure read of the already-fetched
// header, no probe.
// =====================================================================

/** 180 days - a common "good enough to matter" bar; well below a browser's own 1-year recommendation, deliberately lenient to avoid over-flagging */
const HSTS_MIN_MEANINGFUL_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

export function analyzeHsts(headers: Record<string, string>): SecurityAnalysis["hsts"] {
  const raw = headers["strict-transport-security"] ?? null;
  if (!raw) return { present: false, raw: null, maxAgeSeconds: null, includesSubDomains: false, maxAgeTooShort: false };

  const maxAgeMatch = /max-age\s*=\s*(\d+)/i.exec(raw);
  const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : null;
  const includesSubDomains = /includesubdomains/i.test(raw);
  const maxAgeTooShort = maxAgeSeconds !== null && maxAgeSeconds < HSTS_MIN_MEANINGFUL_MAX_AGE_SECONDS;

  return { present: true, raw, maxAgeSeconds, includesSubDomains, maxAgeTooShort };
}

// =====================================================================
// Referrer-Policy quality - presence alone is already checked in
// analysis/issues.ts; this flags only the one specifically dangerous
// value. Pure read of the already-fetched header, no probe.
// =====================================================================

export function analyzeReferrerPolicyQuality(headers: Record<string, string>): SecurityAnalysis["referrerPolicy"] {
  const raw = headers["referrer-policy"] ?? null;
  const weak = raw !== null && raw.trim().toLowerCase() === "unsafe-url";
  return { raw, weak };
}

// =====================================================================
// Insecure password-form submission - pure HTML analysis of the
// already-fetched page body, no probe. Only flags an explicit, absolute
// http:// action on a page that is itself https - a missing/relative/
// same-origin action inherits the page's own https:// scheme and is
// never flagged (false-positive-averse by construction).
// =====================================================================

export function analyzeInsecureFormSubmission($: cheerio.CheerioAPI, pageUrl: string, pageIsHttps: boolean): SecurityAnalysis["insecureFormSubmission"] {
  if (!pageIsHttps) return { findings: [] };

  let base: URL | null = null;
  try {
    base = new URL(pageUrl);
  } catch {
    return { findings: [] };
  }

  const findings: FormSecurityFinding[] = [];
  $("form").each((_, el) => {
    const hasPasswordField = $(el).find('input[type="password"]').length > 0;
    if (!hasPasswordField) return;
    const action = $(el).attr("action");
    if (!action) return; // missing action submits to the current (https) page - safe by construction
    let resolved: URL;
    try {
      resolved = new URL(action, base!);
    } catch {
      return; // unparseable action - not something we can make a deterministic claim about
    }
    if (resolved.protocol === "http:") {
      findings.push({ formAction: action, resolvedAction: resolved.href });
    }
  });

  return { findings: findings.slice(0, 10) };
}

// =====================================================================
// Subresource Integrity - pure HTML analysis of the already-fetched
// page body, no probe. Cross-origin <script>/<link rel=stylesheet> tags
// with no `integrity` attribute. Same-origin resources are never
// flagged - SRI exists to protect against a third party (e.g. a
// compromised CDN) serving different content than expected; a same-
// origin resource has no such supply-chain boundary to protect.
// =====================================================================

export function analyzeSubresourceIntegrity($: cheerio.CheerioAPI, pageUrl: string): SecurityAnalysis["subresourceIntegrity"] {
  let base: URL | null = null;
  try {
    base = new URL(pageUrl);
  } catch {
    return { findings: [] };
  }

  const findings: SriFinding[] = [];
  const check = (tag: "script" | "link", url: string | undefined) => {
    if (!url) return;
    let resolved: URL;
    try {
      resolved = new URL(url, base!);
    } catch {
      return; // unparseable url - not something we can make a deterministic claim about
    }
    if (resolved.host === base!.host) return; // same-origin - no supply-chain boundary to protect
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
    findings.push({ tag, url: resolved.href });
  };

  $("script[src]").each((_, el) => {
    if ($(el).attr("integrity")) return; // already protected
    check("script", $(el).attr("src"));
  });
  $('link[rel="stylesheet"][href]').each((_, el) => {
    if ($(el).attr("integrity")) return;
    check("link", $(el).attr("href"));
  });

  return { findings: findings.slice(0, 10) };
}

// =====================================================================
// Secret-pattern detection - PATTERN MATCHING ONLY, never exploited,
// never harvested. A match only ever produces a redacted preview (see
// redact()) - the full matched text is discarded immediately and never
// stored, logged, or returned from this module in any form.
// =====================================================================

interface SecretPatternDef {
  name: string;
  re: RegExp;
  confidence: "high" | "medium";
}

const SECRET_PATTERNS: SecretPatternDef[] = [
  { name: "AWS Access Key ID", re: /AKIA[0-9A-Z]{16}/g, confidence: "high" },
  { name: "Google API Key", re: /AIza[0-9A-Za-z_-]{35}/g, confidence: "high" },
  { name: "Stripe Live Secret Key", re: /sk_live_[0-9a-zA-Z]{16,}/g, confidence: "high" },
  { name: "Slack Token", re: /xox[baprs]-[0-9A-Za-z-]{10,}/g, confidence: "high" },
  { name: "GitHub Token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g, confidence: "high" },
  { name: "Private Key Block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, confidence: "high" },
  {
    // Deliberately conservative: requires a recognizable variable name
    // AND a reasonably long, quoted value - reduces false positives on
    // placeholder text like `apiKey: "your-key-here"` somewhat, though
    // it can't eliminate them entirely (hence "medium" confidence).
    name: "Hardcoded API key/secret assignment",
    re: /(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["'`]([A-Za-z0-9_-]{20,})["'`]/gi,
    confidence: "medium",
  },
];

/** first 4 + last 4 characters, everything else masked - never the full value */
function redact(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(value.length - 8)}${value.slice(-4)}`;
}

// =====================================================================
// Reverse tabnabbing - pure HTML analysis of the already-fetched page body.
// =====================================================================
export function analyzeReverseTabnabbing($: cheerio.CheerioAPI): SecurityAnalysis["reverseTabnabbing"] {
  const findings: TabnabbingFinding[] = [];
  $('a[target="_blank"], area[target="_blank"]').each((_, el) => {
    const rel = ($(el).attr("rel") ?? "").toLowerCase();
    if (rel.includes("noopener") || rel.includes("noreferrer")) return;
    const href = $(el).attr("href");
    if (!href) return;
    const linkText = $(el).text().trim().slice(0, 60) || "(no visible text)";
    findings.push({ url: href, linkText });
  });
  return { findings: findings.slice(0, 10) };
}

export function scanForSecrets(text: string, location: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { name, re, confidence } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    let matchesForThisPattern = 0;
    while (matchesForThisPattern < 3 && (match = re.exec(text))) {
      const matchedText = match[1] ?? match[0]; // prefer the captured value over the surrounding assignment syntax
      findings.push({ patternName: name, location, redactedPreview: redact(matchedText), confidence });
      matchesForThisPattern += 1;
      if (match[0].length === 0) re.lastIndex += 1; // guard against zero-width matches looping forever
    }
  }
  return findings.slice(0, 10);
}

// =====================================================================
// Dev/staging URL detection - these are plain URLs, not secrets, so the
// full URL is safe to include as-is (unlike secret findings above).
// =====================================================================

interface DevUrlPatternDef {
  kind: DevUrlFinding["kind"];
  re: RegExp;
}

const DEV_URL_PATTERNS: DevUrlPatternDef[] = [
  { kind: "localhost", re: /https?:\/\/localhost(?::\d+)?[^\s"'`<>)]*/gi },
  { kind: "loopback-ip", re: /https?:\/\/127\.0\.0\.1(?::\d+)?[^\s"'`<>)]*/gi },
  { kind: "staging-subdomain", re: /https?:\/\/(?:staging|dev|test)\.[a-z0-9.-]+[^\s"'`<>)]*/gi },
];

export function scanForDevUrls(text: string, location: string): DevUrlFinding[] {
  const findings: DevUrlFinding[] = [];
  for (const { kind, re } of DEV_URL_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    let matchesForThisPattern = 0;
    while (matchesForThisPattern < 5 && (match = re.exec(text))) {
      findings.push({ url: match[0], kind, location });
      matchesForThisPattern += 1;
      if (match[0].length === 0) re.lastIndex += 1;
    }
  }
  return findings.slice(0, 15);
}

// =====================================================================
// Cookies - safe metadata only (name + attribute flags), never values
// =====================================================================

// Deliberately conservative: "user" and "account" were dropped from an
// earlier version of this pattern - they're common substrings of
// entirely non-sensitive cookies (e.g. "user_locale", "account_created_
// banner_dismissed") and produced false positives without adding much
// real detection value over the more specific terms below.
const SENSITIVE_COOKIE_NAME_PATTERN = /sess|auth|token|login|jwt|csrf|xsrf|remember/i;

/**
 * Flags a Domain attribute that is unusually broad - a bare single-label
 * value (e.g. ".com") rather than a real registrable domain. Threshold
 * is deliberately conservative (<=1 label after stripping the leading
 * dot) so an entirely ordinary Domain=.example.com is NEVER flagged -
 * only the genuinely-malformed/overbroad case is.
 */
function isOverlyBroadDomain(domain: string): boolean {
  const stripped = domain.replace(/^\./, "").trim();
  if (!stripped) return false;
  return stripped.split(".").length <= 1;
}

export function analyzeCookies(setCookieHeaders: string[] | undefined): SecurityAnalysis["cookies"] {
  const headers = setCookieHeaders ?? [];
  const findings: CookieFinding[] = headers.map((raw) => {
    const parts = raw.split(";").map((p) => p.trim());
    const name = parts[0]?.split("=")[0]?.trim() || "(unnamed)";
    const attrs = parts.slice(1).map((p) => p.toLowerCase());

    const secure = attrs.includes("secure");
    const httpOnly = attrs.includes("httponly");
    const sameSiteAttr = attrs.find((a) => a.startsWith("samesite"));
    let sameSite: CookieSameSite = "not set";
    if (sameSiteAttr) {
      const value = sameSiteAttr.split("=")[1]?.trim();
      if (value === "strict") sameSite = "Strict";
      else if (value === "lax") sameSite = "Lax";
      else if (value === "none") sameSite = "None";
    }

    // Original-case attribute values (not the lowercased `attrs` above) -
    // domain/path are safe, non-secret metadata, fine to display as-is.
    const rawAttrs = parts.slice(1);
    const domainAttr = rawAttrs.find((p) => p.toLowerCase().startsWith("domain="));
    const domain = domainAttr ? domainAttr.split("=").slice(1).join("=").trim() : null;
    const pathAttr = rawAttrs.find((p) => p.toLowerCase().startsWith("path="));
    const path = pathAttr ? pathAttr.split("=").slice(1).join("=").trim() : null;

    return {
      name,
      secure,
      httpOnly,
      sameSite,
      looksSensitive: SENSITIVE_COOKIE_NAME_PATTERN.test(name),
      domain,
      path,
      overlyBroadDomain: domain ? isOverlyBroadDomain(domain) : false,
    };
  });

  return { observed: headers.length > 0, findings };
}

// =====================================================================
// Debug / development exposure - pattern matches against the ALREADY
// FETCHED page only. Never triggers errors intentionally (that would be
// intrusive testing); only reports what's already visible.
// =====================================================================

const DEBUG_EXPOSURE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "Node.js stack trace", re: /at\s+[\w.$<>]+\s*\([^)]*:\d+:\d+\)/ },
  { name: "Python traceback", re: /Traceback \(most recent call last\)/ },
  { name: "PHP fatal error", re: /Fatal error:.*in.*on line \d+/is },
  { name: "Django debug page", re: /You(?:'|&#39;|&#x27;)re seeing this error because.*DEBUG\s*=\s*True/is },
  { name: "Spring Boot Whitelabel error page", re: /Whitelabel Error Page/i },
  { name: "ASP.NET \"yellow screen of death\"", re: /Server Error in '.*' Application/i },
  { name: "Ruby on Rails framework error", re: /ActionController::RoutingError|ActiveRecord::\w+Error/ },
  { name: "SQL error leaked to response", re: /SQL syntax.*MySQL server version|ORA-\d{5}|PostgreSQL.*ERROR:/is },
];

export function analyzeDebugExposure(bodyText: string, headers: Record<string, string>): SecurityAnalysis["debugExposure"] {
  const indicators: string[] = [];
  for (const { name, re } of DEBUG_EXPOSURE_PATTERNS) {
    if (re.test(bodyText)) indicators.push(name);
  }
  const xPoweredBy = headers["x-powered-by"];
  if (xPoweredBy && /\d/.test(xPoweredBy)) {
    indicators.push(`X-Powered-By header reveals a specific version ("${xPoweredBy}")`);
  }
  const server = headers["server"];
  if (server && /\d/.test(server)) {
    indicators.push(`Server header reveals a specific version ("${server}")`);
  }
  return { indicators: indicators.slice(0, 8) };
}

// =====================================================================
// Redirect chain / host analysis (from already-measured data - no new
// network calls). The redirect LOOP/limit/SSRF-per-hop protection
// already lives in httpCollector.ts and is reused as-is, not touched.
// =====================================================================

export function analyzeRedirectChain(fetchResult: FetchResult): { hostChain: string[]; crossHostRedirect: boolean } {
  const chain =
    fetchResult.redirectChain && fetchResult.redirectChain.length > 0
      ? fetchResult.redirectChain
      : [fetchResult.requestedUrl, fetchResult.finalUrl];

  const hostChain: string[] = [];
  for (const u of chain) {
    try {
      hostChain.push(new URL(u).host);
    } catch {
      /* unparseable hop - shouldn't happen since these were already validated URLs, skip defensively */
    }
  }
  const deduped = [...new Set(hostChain)];
  return { hostChain: deduped, crossHostRedirect: deduped.length > 1 };
}

// =====================================================================
// Guarded probe fetch - the ONE place all additional network calls in
// this module go through. Every call re-validates the target host via
// the exact same SSRF guard collectHttp uses (assertHostAllowed) rather
// than a second, parallel implementation of that guard.
// =====================================================================

interface ProbeOptions {
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  dnsLookupFn?: typeof dnsLookup;
  testBypassHosts?: ReadonlySet<string>;
  /** overrides MAX_PROBE_BODY_BYTES for this call only - used by the script secret/dev-url scan, which needs to read more than a few bytes of a real JS bundle */
  maxBodyBytes?: number;
  /** defaults to GET; the HTTP-methods check uses OPTIONS - a safe, standard, non-destructive method (the same one a browser CORS preflight already sends) */
  method?: "GET" | "OPTIONS";
}

interface ProbeResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

async function guardedProbeFetch(url: URL, opts: ProbeOptions = {}): Promise<ProbeResponse | null> {
  try {
    await assertHostAllowed(url.hostname, opts.dnsLookupFn, opts.testBypassHosts);
  } catch {
    return null; // blocked host (or unresolvable) - never probed, same guard as the real page fetch
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const maxBodyBytes = opts.maxBodyBytes ?? MAX_PROBE_BODY_BYTES;
  const timeout = sleep(timeoutMs).then(() => controller.abort());

  try {
    const response = await fetch(url, {
      method: opts.method ?? "GET",
      redirect: "manual", // single hop only - a redirect just means "not directly exposed at this exact path"
      signal: controller.signal,
      headers: {
        "User-Agent": "A2Z-Web-Insight/0.1 (+https://a2z-web-insight.example/bot)",
        ...opts.extraHeaders,
      },
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });

    // Only read a body when the server told us up front it's small - we
    // never want one of these bounded verification probes to pull down
    // an arbitrarily large file from an untrusted target.
    let bodyText = "";
    const contentLength = Number(headers["content-length"] ?? "");
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength <= maxBodyBytes) {
      try {
        const buf = await response.arrayBuffer();
        bodyText = Buffer.from(buf).toString("utf-8");
      } catch {
        /* status/headers are still useful even without a body */
      }
    }

    return { status: response.status, headers, bodyText };
  } catch {
    return null;
  } finally {
    timeout.catch(() => {});
  }
}

function resolveSameOrigin(url: string, base: URL): URL | null {
  try {
    const resolved = new URL(url, base);
    if (resolved.host !== base.host) return null; // never probe a third-party host
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved;
  } catch {
    return null;
  }
}

// =====================================================================
// CORS - safe, deterministic reflection check. We send a request with a
// clearly fictitious Origin and see whether the server echoes it back
// (a strong, common signal of "reflect any Origin" middleware) or sets
// an unsafe wildcard+credentials combination. No credentialed browser
// request is actually made - this is a plain server-to-server GET.
// =====================================================================

const PROBE_ORIGIN = "https://insight-cors-probe.invalid";

async function probeCors(finalUrl: string, opts: ProbeOptions): Promise<SecurityAnalysis["cors"]> {
  let url: URL;
  try {
    url = parseAndValidateUrl(finalUrl);
  } catch {
    return { probeStatus: "error", allowOriginHeader: null, allowCredentials: false, reflectsArbitraryOrigin: false, wildcardWithCredentialsAttempt: false };
  }

  const res = await guardedProbeFetch(url, { ...opts, extraHeaders: { Origin: PROBE_ORIGIN } });
  if (!res) {
    return { probeStatus: "blocked", allowOriginHeader: null, allowCredentials: false, reflectsArbitraryOrigin: false, wildcardWithCredentialsAttempt: false };
  }

  const allowOriginHeader = res.headers["access-control-allow-origin"] ?? null;
  const allowCredentials = (res.headers["access-control-allow-credentials"] ?? "").toLowerCase() === "true";
  const reflectsArbitraryOrigin = allowOriginHeader === PROBE_ORIGIN;
  // Browsers themselves reject `*` combined with credentials, so a server
  // sending both is a real misconfiguration signal worth surfacing (not
  // evidence of an exploitable browser-based attack on its own).
  const wildcardWithCredentialsAttempt = allowOriginHeader === "*" && allowCredentials;

  return { probeStatus: "checked", allowOriginHeader, allowCredentials, reflectsArbitraryOrigin, wildcardWithCredentialsAttempt };
}

// =====================================================================
// Information disclosure - a small, fixed, deterministic list of
// commonly-accidentally-exposed same-origin paths, PLUS source maps for
// a handful of ACTUALLY OBSERVED same-origin script URLs (never
// guessed/arbitrary paths beyond this fixed list).
// =====================================================================

const INFO_DISCLOSURE_FILE_PATHS = ["/.env", "/.env.local", "/.git/config", "/.git/HEAD", "/.DS_Store", "/wp-config.php.bak", "/config.php.bak", "/backup.sql"];
const INFO_DISCLOSURE_DIR_PATHS = ["/backup/", "/uploads/"];
const DIRECTORY_LISTING_SIGNATURE = /<title>\s*Index of \/|Index of \//i;
const MAX_SOURCE_MAP_CANDIDATES = 3;

async function probeInfoDisclosure(base: URL, scriptSrcs: string[], opts: ProbeOptions): Promise<SecurityAnalysis["infoDisclosure"]> {
  const fileTargets = INFO_DISCLOSURE_FILE_PATHS.map((p) => new URL(p, base));
  const dirTargets = INFO_DISCLOSURE_DIR_PATHS.map((p) => new URL(p, base));
  const dirPathSet = new Set(dirTargets.map((u) => u.pathname));

  const sourceMapTargets = scriptSrcs
    .map((src) => resolveSameOrigin(src, base))
    .filter((u): u is URL => u !== null && !u.pathname.endsWith(".map"))
    .slice(0, MAX_SOURCE_MAP_CANDIDATES)
    .map((u) => new URL(`${u.pathname}.map`, u));

  const allTargets = [...fileTargets, ...dirTargets, ...sourceMapTargets];
  if (allTargets.length === 0) return { probeStatus: "checked", checkedPaths: 0, findings: [] };

  const results = await Promise.all(allTargets.map((u) => guardedProbeFetch(u, opts).then((res) => ({ url: u, res }))));

  const findings: InfoDisclosureFinding[] = [];
  for (const { url, res } of results) {
    if (!res || res.status !== 200) continue;
    const path = url.pathname;
    const contentType = res.headers["content-type"] ?? null;

    if (dirPathSet.has(path)) {
      if (DIRECTORY_LISTING_SIGNATURE.test(res.bodyText)) {
        findings.push({ path, statusCode: res.status, contentType, note: "Directory listing appears to be enabled for this path." });
      }
      continue;
    }
    if (path.endsWith(".map")) {
      const looksLikeSourceMap = res.bodyText.trim().startsWith("{") && /"sources"|"mappings"/.test(res.bodyText);
      if (looksLikeSourceMap) {
        findings.push({ path, statusCode: res.status, contentType, note: "A JavaScript source map is publicly accessible and may expose original source code." });
      }
      continue;
    }
    findings.push({ path, statusCode: res.status, contentType, note: "This path returned a direct 200 response - verify it is not meant to be publicly accessible." });
  }

  const allBlocked = results.length > 0 && results.every((r) => r.res === null);
  return { probeStatus: allBlocked ? "blocked" : "checked", checkedPaths: allTargets.length, findings: findings.slice(0, 10) };
}

// =====================================================================
// Redirect security - HTTP -> HTTPS probe. Best-effort and single-hop:
// only meaningful when the scanned page itself is HTTPS (an HTTP page is
// already flagged elsewhere by the existing "not served over HTTPS"
// check in analysis/issues.ts) and only checked over the same host/port
// the page was scanned on.
// =====================================================================

async function probeHttpToHttps(finalUrl: string, opts: ProbeOptions): Promise<SecurityAnalysis["redirectSecurity"]["httpProbe"]> {
  let url: URL;
  try {
    url = parseAndValidateUrl(finalUrl);
  } catch {
    return { status: "not_applicable", redirectsToHttps: null };
  }
  if (url.protocol !== "https:") return { status: "not_applicable", redirectsToHttps: null };

  const httpUrl = new URL(url.href);
  httpUrl.protocol = "http:";

  const res = await guardedProbeFetch(httpUrl, opts);
  if (!res) return { status: "unreachable", redirectsToHttps: null };

  const isRedirect = res.status >= 300 && res.status < 400;
  const location = res.headers["location"];
  const redirectsToHttps = isRedirect && !!location && location.startsWith("https://");
  return { status: "checked", redirectsToHttps };
}

// =====================================================================
// HTTP methods - a single, safe, same-origin OPTIONS request (a normal,
// non-destructive method - the same one a browser CORS preflight
// already sends) checking whether the server advertises unusually risky
// methods like TRACE/TRACK/CONNECT (classic cross-site-tracing/proxying
// surface). Never sends TRACE/TRACK/CONNECT itself - only observes
// whether the server SAYS it supports them via the Allow header.
// =====================================================================

const RISKY_HTTP_METHODS = new Set(["TRACE", "TRACK", "CONNECT"]);

async function probeHttpMethods(finalUrl: string, opts: ProbeOptions): Promise<SecurityAnalysis["httpMethods"]> {
  let url: URL;
  try {
    url = parseAndValidateUrl(finalUrl);
  } catch {
    return { probeStatus: "error", allowedMethods: [], riskyMethodsExposed: [] };
  }

  const res = await guardedProbeFetch(url, { ...opts, method: "OPTIONS" });
  if (!res) return { probeStatus: "blocked", allowedMethods: [], riskyMethodsExposed: [] };

  const allowHeader = res.headers["allow"] ?? res.headers["access-control-allow-methods"] ?? null;
  if (!allowHeader) return { probeStatus: "checked", allowedMethods: [], riskyMethodsExposed: [] };

  const allowedMethods = allowHeader
    .split(",")
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
  const riskyMethodsExposed = allowedMethods.filter((m) => RISKY_HTTP_METHODS.has(m));
  return { probeStatus: "checked", allowedMethods, riskyMethodsExposed };
}

// =====================================================================
// TLS certificate inspection - a REAL TLS handshake via Node's built-in
// `tls` module (no new dependency, no undici/openssl bindings needed),
// entirely separate from the HTTP fetch layer used everywhere else in
// this file. Connects with `rejectUnauthorized: false` DELIBERATELY -
// this lets an invalid/expired/self-signed certificate still be
// INSPECTED and its exact problem reported via Node's own
// `authorizationError` reason code, rather than the connection simply
// failing and telling us nothing. Still fully SSRF-guarded: the target
// hostname goes through the exact same `assertHostAllowed()` used by
// every other probe before the socket is ever opened.
// =====================================================================

const DEFAULT_HTTPS_PORT = 443;
const DEPRECATED_TLS_PROTOCOLS = new Set(["TLSv1", "TLSv1.1", "SSLv3", "SSLv2"]);

const NOT_APPLICABLE_TLS_RESULT: SecurityAnalysis["tlsCertificate"] = {
  probeStatus: "not_applicable",
  protocol: null,
  cipherName: null,
  authorized: null,
  authorizationError: null,
  validTo: null,
  daysUntilExpiry: null,
  publicKeyBits: null,
  publicKeyIsRsa: false,
};

async function probeTlsCertificate(finalUrl: string, opts: ProbeOptions): Promise<SecurityAnalysis["tlsCertificate"]> {
  let url: URL;
  try {
    url = parseAndValidateUrl(finalUrl);
  } catch {
    return { ...NOT_APPLICABLE_TLS_RESULT, probeStatus: "error" };
  }
  if (url.protocol !== "https:") return NOT_APPLICABLE_TLS_RESULT; // nothing to inspect - the plain-HTTP case is already covered elsewhere

  const hostname = url.hostname;
  const port = url.port ? Number(url.port) : DEFAULT_HTTPS_PORT;

  try {
    await assertHostAllowed(hostname, opts.dnsLookupFn, opts.testBypassHosts);
  } catch {
    return { ...NOT_APPLICABLE_TLS_RESULT, probeStatus: "blocked" };
  }

  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: SecurityAnalysis["tlsCertificate"]) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let socket: tls.TLSSocket;
    try {
      socket = tls.connect({
        host: hostname,
        port,
        servername: hostname,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      });
    } catch {
      settle({ ...NOT_APPLICABLE_TLS_RESULT, probeStatus: "error" });
      return;
    }

    socket.once("secureConnect", () => {
      const protocol = socket.getProtocol();
      const cipher = socket.getCipher();
      const authorized = socket.authorized;
      const authorizationError = socket.authorizationError ? String(socket.authorizationError) : null;
      const cert = socket.getPeerCertificate();
      const validTo = cert && cert.valid_to ? cert.valid_to : null;
      let daysUntilExpiry: number | null = null;
      if (validTo) {
        const expiryMs = new Date(validTo).getTime();
        if (Number.isFinite(expiryMs)) {
          daysUntilExpiry = Math.floor((expiryMs - Date.now()) / (24 * 60 * 60 * 1000));
        }
      }
      const certAny = cert as unknown as { modulus?: string; bits?: number };
      const publicKeyIsRsa = typeof certAny.modulus === "string" && certAny.modulus.length > 0;
      const publicKeyBits = publicKeyIsRsa && typeof certAny.bits === "number" ? certAny.bits : null;
      socket.end();
      settle({ probeStatus: "checked", protocol: protocol || null, cipherName: cipher?.name ?? null, authorized, authorizationError, validTo, daysUntilExpiry, publicKeyBits, publicKeyIsRsa });
    });

    socket.once("error", () => {
      settle({ ...NOT_APPLICABLE_TLS_RESULT, probeStatus: "error" });
    });
    socket.once("timeout", () => {
      socket.destroy();
      settle({ ...NOT_APPLICABLE_TLS_RESULT, probeStatus: "unreachable" });
    });
  });
}

// =====================================================================
// DNS CAA (Certification Authority Authorization) records - a real,
// directly-queried DNS fact via Node's built-in `dns` module (the exact
// same DNS infrastructure `assertHostAllowed` already uses for its own
// A/AAAA lookup - not a second, different resolution mechanism).
// Absence is common and is NOT itself a strong negative signal (most
// domains don't set CAA) - reported as a low-severity hardening note.
// ENODATA/ENOTFOUND specifically mean "queried successfully, no CAA
// records exist" (a real, verified absence); any other error (timeout,
// server failure) means the query itself didn't succeed and is reported
// as genuinely unverified rather than conflated with "no records."
// =====================================================================

async function checkCaaRecords(hostname: string, dnsResolveCaaFn: typeof dnsResolveCaa = dnsResolveCaa): Promise<SecurityAnalysis["caaRecords"]> {
  try {
    const records = await dnsResolveCaaFn(hostname);
    const summaries = records.map((r) => {
      const parts: string[] = [];
      if (r.critical) parts.push("critical");
      if (r.issue) parts.push(`issue: ${r.issue}`);
      if (r.issuewild) parts.push(`issuewild: ${r.issuewild}`);
      if (r.iodef) parts.push(`iodef: ${r.iodef}`);
      return parts.join(", ") || "(unrecognized CAA record)";
    });
    return { probeStatus: "checked", present: records.length > 0, records: summaries };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENODATA" || code === "ENOTFOUND") {
      return { probeStatus: "checked", present: false, records: [] };
    }
    return { probeStatus: "error", present: false, records: [] };
  }
}

// =====================================================================
// Same-origin script scanning - fetches a small, bounded number of the
// ACTUALLY-OBSERVED same-origin <script src> URLs (never guessed paths,
// never cross-origin) and runs scanForSecrets/scanForDevUrls over each.
// Uses a larger body cap than the other probes (MAX_SCRIPT_SCAN_BODY_BYTES
// vs. MAX_PROBE_BODY_BYTES) since real JS bundles are bigger than the
// status-check responses the other probes expect - still bounded, still
// same-origin, still through the same guardedProbeFetch/SSRF guard.
// =====================================================================

const MAX_SCRIPT_SCAN_CANDIDATES = 5;
const MAX_SCRIPT_SCAN_BODY_BYTES = 300_000;

interface ScriptScanResult {
  probeStatus: "checked" | "blocked" | "error";
  scannedLocations: number;
  secrets: SecretFinding[];
  devUrls: DevUrlFinding[];
}

async function scanSameOriginScripts(base: URL | null, scriptSrcs: string[], opts: ProbeOptions): Promise<ScriptScanResult> {
  if (!base) return { probeStatus: "error", scannedLocations: 0, secrets: [], devUrls: [] };

  const targets = scriptSrcs
    .map((src) => resolveSameOrigin(src, base))
    .filter((u): u is URL => u !== null)
    .slice(0, MAX_SCRIPT_SCAN_CANDIDATES);
  if (targets.length === 0) return { probeStatus: "checked", scannedLocations: 0, secrets: [], devUrls: [] };

  const results = await Promise.all(
    targets.map((u) => guardedProbeFetch(u, { ...opts, maxBodyBytes: MAX_SCRIPT_SCAN_BODY_BYTES }).then((res) => ({ url: u, res }))),
  );
  const allBlocked = results.every((r) => r.res === null);

  const secrets: SecretFinding[] = [];
  const devUrls: DevUrlFinding[] = [];
  let scannedLocations = 0;
  for (const { url, res } of results) {
    if (!res || res.status !== 200 || !res.bodyText) continue;
    scannedLocations += 1;
    secrets.push(...scanForSecrets(res.bodyText, url.pathname));
    devUrls.push(...scanForDevUrls(res.bodyText, url.pathname));
  }

  return {
    probeStatus: allBlocked ? "blocked" : "checked",
    scannedLocations,
    secrets: secrets.slice(0, 10),
    devUrls: devUrls.slice(0, 15),
  };
}

// =====================================================================
// Verification-status summary. Additive only - does not feed the
// severity/Issue/scoring model. See SecurityAnalysis["verification"]'s
// doc comment in types.ts for exactly what "verified"/"unverified"/
// "not_applicable" mean here.
// =====================================================================

function fromProbeStatus(status: "checked" | "unreachable" | "blocked" | "error" | "not_applicable"): VerificationStatus {
  if (status === "checked") return "verified";
  if (status === "not_applicable") return "not_applicable";
  return "unverified"; // unreachable | blocked | error
}

function computeVerification(parts: {
  corsProbeStatus: SecurityAnalysis["cors"]["probeStatus"];
  infoDisclosureProbeStatus: SecurityAnalysis["infoDisclosure"]["probeStatus"];
  httpProbeStatus: SecurityAnalysis["redirectSecurity"]["httpProbe"]["status"];
  secretExposureProbeStatus: SecurityAnalysis["secretExposure"]["probeStatus"];
  httpMethodsProbeStatus: SecurityAnalysis["httpMethods"]["probeStatus"];
  tlsCertificateProbeStatus: SecurityAnalysis["tlsCertificate"]["probeStatus"];
  caaRecordsProbeStatus: SecurityAnalysis["caaRecords"]["probeStatus"];
}): SecurityAnalysis["verification"] {
  return {
    // Directly observed from the already-fetched response - always a
    // real (possibly negative) observation, never "we didn't check."
    https: "verified",
    headers: "verified",
    csp: "verified",
    clickjacking: "verified",
    cookies: "verified",
    debugExposure: "verified",
    crossOriginPolicies: "verified",
    permissionsPolicy: "verified",
    hsts: "verified",
    referrerPolicy: "verified",
    insecureFormSubmission: "verified",
    // devUrlExposure always at least scans the page HTML itself (no
    // network dependency for that part), so it's always "verified" even
    // when the same-origin script probes are blocked - scannedLocations
    // on secretExposure/devUrlExposure tells you exactly how much was
    // actually covered.
    devUrlExposure: "verified",
    // subresourceIntegrity is pure HTML analysis, same as devUrlExposure.
    subresourceIntegrity: "verified",
    reverseTabnabbing: "verified",
    cors: fromProbeStatus(parts.corsProbeStatus),
    infoDisclosure: fromProbeStatus(parts.infoDisclosureProbeStatus),
    redirectSecurity: fromProbeStatus(parts.httpProbeStatus),
    secretExposure: fromProbeStatus(parts.secretExposureProbeStatus),
    httpMethods: fromProbeStatus(parts.httpMethodsProbeStatus),
    tlsCertificate: fromProbeStatus(parts.tlsCertificateProbeStatus),
    caaRecords: fromProbeStatus(parts.caaRecordsProbeStatus),
  };
}

// =====================================================================
// Orchestration
// =====================================================================

export interface CollectSecurityOptions {
  /** injectable for tests */
  dnsLookupFn?: typeof dnsLookup;
  /** injectable for tests - overrides the CAA record lookup */
  dnsResolveCaaFn?: typeof dnsResolveCaa;
  /** TEST-ONLY escape hatch - see the identical option on collectHttp in httpCollector.ts */
  testBypassHosts?: ReadonlySet<string>;
  probeTimeoutMs?: number;
}

const BLOCKED_PROBE_RESULT: SecurityAnalysis["cors"] = { probeStatus: "error", allowOriginHeader: null, allowCredentials: false, reflectsArbitraryOrigin: false, wildcardWithCredentialsAttempt: false };
const BLOCKED_INFO_DISCLOSURE_RESULT: SecurityAnalysis["infoDisclosure"] = { probeStatus: "error", checkedPaths: 0, findings: [] };
const BLOCKED_SCRIPT_SCAN_RESULT: ScriptScanResult = { probeStatus: "error", scannedLocations: 0, secrets: [], devUrls: [] };
const BLOCKED_HTTP_METHODS_RESULT: SecurityAnalysis["httpMethods"] = { probeStatus: "error", allowedMethods: [], riskyMethodsExposed: [] };

/**
 * Full-website security verification, MEASURE step. Never throws - any
 * unexpected failure in a probe degrades that probe's result to
 * "couldn't verify" rather than failing the whole scan (same philosophy
 * as pipeline.ts's safeAnalyzePerformance for the CWV provider).
 */
export async function collectSecurity(fetchResult: FetchResult, options: CollectSecurityOptions = {}): Promise<SecurityAnalysis> {
  const probeOpts: ProbeOptions = {
    dnsLookupFn: options.dnsLookupFn,
    testBypassHosts: options.testBypassHosts,
    timeoutMs: options.probeTimeoutMs,
  };

  const csp = analyzeCsp(fetchResult.headers);
  const clickjacking = analyzeClickjacking(fetchResult.headers);
  const cookies = analyzeCookies(fetchResult.setCookieHeaders);
  const debugExposure = analyzeDebugExposure(fetchResult.bodyText, fetchResult.headers);
  const crossOriginPolicies = analyzeCrossOriginPolicies(fetchResult.headers);
  const permissionsPolicy = analyzePermissionsPolicy(fetchResult.headers);
  const hsts = analyzeHsts(fetchResult.headers);
  const referrerPolicy = analyzeReferrerPolicyQuality(fetchResult.headers);
  const { hostChain, crossHostRedirect } = analyzeRedirectChain(fetchResult);

  // The page HTML itself is always scanned - no network dependency for
  // this part, so it never degrades to "unverified."
  const inlineSecrets = scanForSecrets(fetchResult.bodyText, "page HTML (inline content)");
  const inlineDevUrls = scanForDevUrls(fetchResult.bodyText, "page HTML (inline content)");

  const $ = cheerio.load(fetchResult.bodyText);
  const { scriptSrcs, resourceRefs } = parseResources($);
  const mixedContent = analyzeMixedContent(resourceRefs, fetchResult.httpsUsed);
  const insecureFormSubmission = analyzeInsecureFormSubmission($, fetchResult.finalUrl, fetchResult.httpsUsed);
  const subresourceIntegrity = analyzeSubresourceIntegrity($, fetchResult.finalUrl);

  let base: URL | null = null;
  try {
    base = parseAndValidateUrl(fetchResult.finalUrl);
  } catch {
    base = null;
  }

  let cors: SecurityAnalysis["cors"];
  let infoDisclosure: SecurityAnalysis["infoDisclosure"];
  let httpProbe: SecurityAnalysis["redirectSecurity"]["httpProbe"];
  let scriptScan: ScriptScanResult;
  let httpMethods: SecurityAnalysis["httpMethods"];
  let tlsCertificate: SecurityAnalysis["tlsCertificate"];
  let caaRecords: SecurityAnalysis["caaRecords"];
  try {
    const corsPromise: Promise<SecurityAnalysis["cors"]> = base ? probeCors(fetchResult.finalUrl, probeOpts) : Promise.resolve(BLOCKED_PROBE_RESULT);
    const infoDisclosurePromise: Promise<SecurityAnalysis["infoDisclosure"]> = base
      ? probeInfoDisclosure(base, scriptSrcs, probeOpts)
      : Promise.resolve(BLOCKED_INFO_DISCLOSURE_RESULT);
    const httpMethodsPromise: Promise<SecurityAnalysis["httpMethods"]> = base ? probeHttpMethods(fetchResult.finalUrl, probeOpts) : Promise.resolve(BLOCKED_HTTP_METHODS_RESULT);
    const caaRecordsPromise: Promise<SecurityAnalysis["caaRecords"]> = base
      ? checkCaaRecords(base.hostname, options.dnsResolveCaaFn)
      : Promise.resolve({ probeStatus: "error" as const, present: false, records: [] });
    [cors, infoDisclosure, httpProbe, scriptScan, httpMethods, tlsCertificate, caaRecords] = await Promise.all([
      corsPromise,
      infoDisclosurePromise,
      probeHttpToHttps(fetchResult.finalUrl, probeOpts),
      scanSameOriginScripts(base, scriptSrcs, probeOpts),
      httpMethodsPromise,
      probeTlsCertificate(fetchResult.finalUrl, probeOpts),
      caaRecordsPromise,
    ]);
  } catch {
    cors = BLOCKED_PROBE_RESULT;
    infoDisclosure = BLOCKED_INFO_DISCLOSURE_RESULT;
    httpProbe = { status: "unreachable", redirectsToHttps: null };
    scriptScan = BLOCKED_SCRIPT_SCAN_RESULT;
    httpMethods = BLOCKED_HTTP_METHODS_RESULT;
    tlsCertificate = { ...NOT_APPLICABLE_TLS_RESULT, probeStatus: "error" };
    caaRecords = { probeStatus: "error", present: false, records: [] };
  }

  const secretExposure: SecurityAnalysis["secretExposure"] = {
    probeStatus: scriptScan.probeStatus,
    // +1 for the page HTML itself, which is always scanned regardless of
    // how the script probes went.
    scannedLocations: 1 + scriptScan.scannedLocations,
    findings: [...inlineSecrets, ...scriptScan.secrets].slice(0, 10),
  };
  const devUrlExposure: SecurityAnalysis["devUrlExposure"] = {
    findings: [...inlineDevUrls, ...scriptScan.devUrls].slice(0, 15),
  };

  const verification = computeVerification({
    corsProbeStatus: cors.probeStatus,
    infoDisclosureProbeStatus: infoDisclosure.probeStatus,
    httpProbeStatus: httpProbe.status,
    secretExposureProbeStatus: secretExposure.probeStatus,
    httpMethodsProbeStatus: httpMethods.probeStatus,
    tlsCertificateProbeStatus: tlsCertificate.probeStatus,
    caaRecordsProbeStatus: caaRecords.probeStatus,
  });

  return {
    csp,
    clickjacking,
    mixedContent,
    cookies,
    cors,
    infoDisclosure,
    debugExposure,
    redirectSecurity: { hostChain, crossHostRedirect, httpProbe },
    crossOriginPolicies,
    permissionsPolicy,
    secretExposure,
    devUrlExposure,
    httpMethods,
    hsts,
    referrerPolicy,
    insecureFormSubmission,
    tlsCertificate,
    caaRecords,
    subresourceIntegrity,
    reverseTabnabbing,
    verification,
  };
}
