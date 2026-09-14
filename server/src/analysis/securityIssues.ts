import type { CspFinding, Evidence, Issue, Severity, SecurityAnalysis } from "../types.js";

/**
 * Turns securityCollector.ts's facts into the existing Issue shape - the
 * SAME `Issue` type, same evidence-array convention, and same downstream
 * scoring (`analysis/scorer.ts`'s `security` category) as the security
 * checks already in analysis/issues.ts. No parallel scoring system.
 *
 * Own id-counter namespace ("security-adv-N") so these ids never collide
 * with issues.ts's existing "security-N" ids - same pattern
 * analysis/cwvIssues.ts uses ("performance-cwv-N" vs issues.ts's
 * "performance-N").
 *
 * DELIBERATE NON-DUPLICATION with analysis/issues.ts's existing security
 * checks (HTTPS presence, HSTS, X-Content-Type-Options, basic clickjacking
 * presence, basic CSP presence, Referrer-Policy, basic mixed content via
 * img/script/link/iframe): this file only adds checks that are genuinely
 * NEW evidence - CSP quality, cookie attributes, CORS behavior, info
 * disclosure, debug exposure, redirect security, and the clickjacking
 * CONFLICT case, plus mixed content for font/media resource types that
 * issues.ts's html.insecureResourceRefs does not collect.
 */

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 100, high: 70, medium: 40, low: 15 };

/** kept in sync with securityCollector.ts's own copy - deliberately duplicated rather than exported/shared, since it's a tiny, stable, presentation-layer classification list, not a contract the two files need to coordinate on dynamically */
const DEPRECATED_TLS_PROTOCOLS = new Set(["TLSv1", "TLSv1.1", "SSLv3", "SSLv2"]);
const WEAK_CIPHER_PATTERN = /RC4|DES|MD5|NULL|EXPORT|ADH|AECDH/i;
const WEAK_RSA_KEY_BITS = 2048;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `security-adv-${counter}`;
}
export function resetAdvancedSecurityIssueIdCounter() {
  counter = 0;
}

function makeIssue(input: Omit<Issue, "id" | "priorityScore" | "category">): Issue {
  return { ...input, category: "security", id: nextId(), priorityScore: SEVERITY_WEIGHT[input.severity] };
}

const HIGH_IMPACT_CSP_DIRECTIVES = new Set(["default-src", "script-src"]);

function worstCspSeverity(weaknesses: CspFinding[]): Severity {
  let worst: Severity = "low";
  for (const w of weaknesses) {
    const highImpactDirective = HIGH_IMPACT_CSP_DIRECTIVES.has(w.directive);
    let s: Severity = "low";
    if (w.issue === "unsafe-eval") s = highImpactDirective ? "high" : "medium";
    else if (w.issue === "unsafe-inline") s = highImpactDirective ? "high" : "medium";
    else if (w.issue === "wildcard-source") s = highImpactDirective ? "high" : "medium";
    else if (w.issue === "insecure-http-source") s = "medium";
    else if (w.issue === "contradictory-upgrade-insecure") s = "low";
    else if (w.issue === "missing-script-restriction") s = "high"; // no default-src/script-src at all = no real XSS mitigation, regardless of directive field
    if (SEVERITY_WEIGHT[s] > SEVERITY_WEIGHT[worst]) worst = s;
  }
  return worst;
}

export function detectAdvancedSecurityIssues(security: SecurityAnalysis, page: string): Issue[] {
  const issues: Issue[] = [];

  // ---------------- CSP quality (only meaningful if a CSP exists at all -
  // its absence is already flagged by analysis/issues.ts) ----------------
  if (security.csp.present && security.csp.weaknesses.length > 0) {
    issues.push(
      makeIssue({
        severity: worstCspSeverity(security.csp.weaknesses),
        title: "Content-Security-Policy contains weak directives",
        affected: page,
        whyItMatters:
          "A CSP header being present does not mean it is effective - directives like 'unsafe-inline', 'unsafe-eval', or wildcard sources substantially reduce or eliminate the XSS protection a CSP is meant to provide.",
        estimatedImpact: `${security.csp.weaknesses.length} weak directive value(s) found.`,
        recommendedFix:
          "Replace 'unsafe-inline'/'unsafe-eval' with nonces or hashes for legitimate inline scripts, and replace wildcard/http: sources with an explicit allowlist of the exact origins actually needed.",
        difficulty: "moderate",
        source: "measured",
        evidence: security.csp.weaknesses
          .slice(0, 5)
          .map((w): Evidence => ({ type: "header", label: `CSP ${w.directive}`, value: w.detail })),
      }),
    );
  }

  // ---------------- Clickjacking: conflicting signals ----------------
  if (security.clickjacking.conflicting) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "X-Frame-Options and CSP frame-ancestors give conflicting clickjacking protection",
        affected: page,
        whyItMatters:
          "When these two headers disagree, the effective protection depends on which one a given browser or intermediary honors - some visitors may end up with weaker framing protection than intended.",
        recommendedFix: "Align X-Frame-Options and the CSP frame-ancestors directive so they express the same policy (or rely on frame-ancestors alone, since it is the modern standard, and drop X-Frame-Options).",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "header", label: "X-Frame-Options vs CSP frame-ancestors", value: "conflicting values" }],
      }),
    );
  }

  // ---------------- Mixed content: font/media (issues.ts already covers
  // script/img/link/iframe via html.insecureResourceRefs - see file doc).
  // Fonts/media are always "passive" mixed content (display-only, can't
  // execute code) - "active" mixed content (script/iframe) is the more
  // serious case and is what issues.ts's existing check already covers.
  // See MixedContentFinding's doc in types.ts for the active/passive
  // distinction and its limits (a static classification, not a browser-
  // observed "was this actually blocked" fact). ----------------
  const extraMixedContent = security.mixedContent.filter((f) => f.resourceType === "font" || f.resourceType === "media");
  if (extraMixedContent.length > 0) {
    issues.push(
      makeIssue({
        severity: extraMixedContent.length > 3 ? "high" : "medium",
        title: "Mixed content: insecure font/media resources loaded on an HTTPS page",
        affected: page,
        whyItMatters:
          "Loading HTTP fonts or media on an HTTPS page breaks the security guarantees of encryption for those resources and may be blocked by browsers. This is passive mixed content (display-only) - lower risk than active mixed content like an insecure script, which issues.ts's existing HTTPS/mixed-content check already flags separately.",
        estimatedImpact: `${extraMixedContent.length} insecure font/media reference(s) found, e.g. ${extraMixedContent[0].url}`,
        recommendedFix: "Update these resource URLs to use https:// or protocol-relative URLs.",
        difficulty: "easy",
        source: "measured",
        evidence: extraMixedContent.slice(0, 5).map((f): Evidence => ({ type: "html", label: `Insecure ${f.resourceType} (passive mixed content)`, value: f.url })),
      }),
    );
  }

  // ---------------- Cookies ----------------
  if (security.cookies.observed) {
    const offenders = security.cookies.findings.filter((c) => c.looksSensitive && (!c.secure || !c.httpOnly));
    if (offenders.length > 0) {
      const anyMissingSecure = offenders.some((c) => !c.secure);
      issues.push(
        makeIssue({
          severity: anyMissingSecure ? "high" : "medium",
          title: "Sensitive-looking cookies are missing recommended security attributes",
          affected: page,
          whyItMatters:
            "Cookies whose names suggest they carry session/authentication state should set Secure (never sent over plain HTTP) and HttpOnly (not readable by JavaScript, limiting theft via XSS). This is a name-based heuristic, not proof the cookie is actually sensitive.",
          estimatedImpact: `${offenders.length} cookie(s): ${offenders.map((c) => c.name).join(", ")}.`,
          recommendedFix: "Set the Secure and HttpOnly attributes on any cookie used for authentication or session state, and set SameSite=Lax or Strict unless cross-site delivery is genuinely required.",
          difficulty: "easy",
          source: "measured",
          evidence: offenders
            .slice(0, 5)
            .map((c): Evidence => ({ type: "header", label: `Cookie "${c.name}"`, value: `Secure=${c.secure} HttpOnly=${c.httpOnly} SameSite=${c.sameSite}` })),
        }),
      );
    }

    const broadDomainCookies = security.cookies.findings.filter((c) => c.overlyBroadDomain);
    if (broadDomainCookies.length > 0) {
      issues.push(
        makeIssue({
          severity: "medium",
          title: "A cookie's Domain attribute is unusually broad",
          affected: page,
          whyItMatters: "An overly broad Domain scope (e.g. a bare single-label value) can cause a cookie to be sent to unintended hosts, or may simply indicate a misconfiguration.",
          estimatedImpact: `${broadDomainCookies.length} cookie(s): ${broadDomainCookies.map((c) => `${c.name} (Domain=${c.domain})`).join(", ")}.`,
          recommendedFix: "Set the Domain attribute to the specific registrable domain the cookie is actually meant to be scoped to, or omit it to default to the exact host.",
          difficulty: "easy",
          source: "measured",
          evidence: broadDomainCookies.slice(0, 5).map((c): Evidence => ({ type: "header", label: `Cookie "${c.name}"`, value: `Domain=${c.domain}` })),
        }),
      );
    }
  }

  // ---------------- Cross-origin isolation headers ----------------
  if (!security.crossOriginPolicies.coop && !security.crossOriginPolicies.corp && !security.crossOriginPolicies.coep) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "No cross-origin isolation headers set (COOP/CORP/COEP)",
        affected: page,
        whyItMatters:
          "Cross-Origin-Opener-Policy, Cross-Origin-Resource-Policy, and Cross-Origin-Embedder-Policy help isolate a page from cross-origin attacks (e.g. Spectre-style side channels, being embedded as a sub-resource unexpectedly). This is a hardening recommendation, not evidence of an active vulnerability - most sites today don't set these.",
        recommendedFix: "Consider setting Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Resource-Policy: same-origin (or same-site) where they don't break legitimate cross-origin embedding you rely on.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "header", label: "COOP / CORP / COEP", value: "none of the three are set" }],
      }),
    );
  }

  // ---------------- Permissions-Policy ----------------
  if (!security.permissionsPolicy.present) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "No Permissions-Policy header set",
        affected: page,
        whyItMatters:
          "Permissions-Policy lets a page explicitly disable browser features it doesn't use (camera, microphone, geolocation, etc.), reducing what a successful XSS or a malicious embedded iframe could access. This is a hardening recommendation, not evidence of an active vulnerability - most sites today don't set it.",
        recommendedFix: "Consider setting Permissions-Policy to explicitly disable browser features this site doesn't use, e.g. Permissions-Policy: camera=(), microphone=(), geolocation=().",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "header", label: "Permissions-Policy", value: "missing" }],
      }),
    );
  } else if (security.permissionsPolicy.wildcardFeatures.length > 0) {
    const features = security.permissionsPolicy.wildcardFeatures;
    issues.push(
      makeIssue({
        severity: "medium",
        title: `Permissions-Policy grants a sensitive feature to any origin: ${features.join(", ")}`,
        affected: page,
        whyItMatters:
          'A sensitive feature (camera/microphone/geolocation/payment/usb) explicitly set to "*" allows ANY embedded origin to request it - this defeats the point of setting Permissions-Policy for that feature while making the site look configured.',
        estimatedImpact: `Observed: ${security.permissionsPolicy.raw}`,
        recommendedFix: 'Replace the wildcard with an explicit allowlist (e.g. camera=(self "https://trusted-partner.com")) or disable the feature entirely with camera=().',
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "header", label: "Permissions-Policy", value: security.permissionsPolicy.raw ?? "" }],
      }),
    );
  }

  // ---------------- HTTP methods ----------------
  if (security.httpMethods.probeStatus === "checked" && security.httpMethods.riskyMethodsExposed.length > 0) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: `Server advertises unusually risky HTTP method(s): ${security.httpMethods.riskyMethodsExposed.join(", ")}`,
        affected: page,
        whyItMatters:
          "TRACE/TRACK/CONNECT are rarely needed by ordinary websites and TRACE in particular has a history of cross-site tracing (XST) issues in some server/browser combinations. This reflects what the server's Allow header advertises, not a confirmed exploit - Insight Web never actually sends a TRACE/TRACK/CONNECT request.",
        estimatedImpact: `Allow header included: ${security.httpMethods.allowedMethods.join(", ")}.`,
        recommendedFix: "Disable TRACE/TRACK/CONNECT at the web server or load balancer level unless a specific, understood need exists for them.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "header", label: "Allow", value: security.httpMethods.allowedMethods.join(", ") }],
      }),
    );
  }

  // ---------------- HSTS quality (presence is already checked in issues.ts) ----------------
  if (security.hsts.present && security.hsts.maxAgeTooShort) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Strict-Transport-Security max-age is too short to provide durable protection",
        affected: page,
        whyItMatters:
          "HSTS only protects a visitor for as long as their browser remembers the policy - a short max-age means that memory expires quickly, and the visitor loses HSTS protection until they visit again over HTTPS. A common recommendation is at least 6 months, with 1 year+ for sites that want HSTS preload eligibility.",
        estimatedImpact: `Observed: ${security.hsts.raw}`,
        recommendedFix: "Increase max-age to at least 15552000 (180 days), e.g. Strict-Transport-Security: max-age=31536000; includeSubDomains.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "header", label: "Strict-Transport-Security", value: security.hsts.raw ?? "" }],
      }),
    );
  }

  // ---------------- Referrer-Policy quality (presence is already checked in issues.ts) ----------------
  if (security.referrerPolicy.weak) {
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Referrer-Policy is set to the unsafe-url value",
        affected: page,
        whyItMatters:
          "unsafe-url always sends the full referrer URL - including any sensitive data in the query string - to every destination a visitor is linked to, even when navigating from HTTPS to plain HTTP (a downgrade). This is the one Referrer-Policy value specifically called out as dangerous; other values (even older/legacy ones) are not flagged by this check.",
        estimatedImpact: `Observed: Referrer-Policy: ${security.referrerPolicy.raw}`,
        recommendedFix: "Use a safer value such as strict-origin-when-cross-origin (sends the full URL only same-origin, and only the origin cross-origin, never on a downgrade).",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "header", label: "Referrer-Policy", value: security.referrerPolicy.raw ?? "" }],
      }),
    );
  }

  // ---------------- Insecure password-form submission ----------------
  if (security.insecureFormSubmission.findings.length > 0) {
    const findings = security.insecureFormSubmission.findings;
    issues.push(
      makeIssue({
        severity: "critical",
        title: "A password form on this HTTPS page submits to an insecure http:// URL",
        affected: page,
        whyItMatters: "Credentials entered into this form would be sent over an unencrypted connection, where they can be intercepted or tampered with in transit - regardless of the page itself being served over HTTPS.",
        estimatedImpact: `${findings.length} form(s), e.g. action="${findings[0].formAction}" -> ${findings[0].resolvedAction}`,
        recommendedFix: "Update the form's action to an https:// URL (or a relative path, which will inherit the page's own https:// scheme).",
        difficulty: "easy",
        source: "measured",
        evidence: findings.slice(0, 5).map((f): Evidence => ({ type: "html", label: "Password form action", value: f.resolvedAction })),
      }),
    );
  }

  // ---------------- TLS certificate (real handshake evidence) ----------------
  if (security.tlsCertificate.probeStatus === "checked") {
    const tls = security.tlsCertificate;
    if (tls.protocol && DEPRECATED_TLS_PROTOCOLS.has(tls.protocol)) {
      issues.push(
        makeIssue({
          severity: "high",
          title: `Deprecated TLS protocol version negotiated: ${tls.protocol}`,
          affected: page,
          whyItMatters: `${tls.protocol} has known weaknesses and is disabled or actively being removed by modern browsers and PCI-DSS compliance requirements. This was observed directly from a real TLS handshake, not inferred.`,
          estimatedImpact: `Negotiated protocol: ${tls.protocol}${tls.cipherName ? ` (cipher: ${tls.cipherName})` : ""}.`,
          recommendedFix: "Disable TLSv1.0/1.1/SSLv3 on the server and require TLSv1.2 or newer (TLSv1.3 preferred).",
          difficulty: "moderate",
          source: "measured",
          evidence: [{ type: "computed", label: "Negotiated TLS protocol", value: tls.protocol }],
        }),
      );
    }

    if (tls.authorized === false) {
      const err = tls.authorizationError ?? "";
      let severity: Severity = "high";
      let title = "TLS certificate failed validation";
      let whyItMatters = "Browsers will show visitors a security warning (or block the page outright) when a certificate doesn't validate.";
      if (err === "CERT_HAS_EXPIRED") {
        severity = "critical";
        title = "TLS certificate has expired";
        whyItMatters = "An expired certificate causes every visitor's browser to show a hard security warning - this is actively broken right now, not a future risk.";
      } else if (err.includes("SELF_SIGNED")) {
        severity = "high";
        title = "TLS certificate is self-signed";
        whyItMatters = "A self-signed certificate is not trusted by any browser's root store - every visitor sees a security warning.";
      } else if (err.includes("ALTNAME") || err.includes("HOSTNAME")) {
        severity = "critical";
        title = "TLS certificate does not match this hostname";
        whyItMatters = "The certificate presented does not cover this domain - browsers will block the connection with a hostname-mismatch warning.";
      }
      issues.push(
        makeIssue({
          severity,
          title,
          affected: page,
          whyItMatters,
          estimatedImpact: `TLS library reported: ${tls.authorizationError ?? "unknown validation failure"}.`,
          recommendedFix: "Obtain and install a valid certificate from a trusted certificate authority covering this exact hostname, and ensure it has not expired.",
          difficulty: "moderate",
          source: "measured",
          evidence: [{ type: "computed", label: "TLS authorization result", value: `authorized=false (${tls.authorizationError ?? "unknown reason"})` }],
        }),
      );
    } else if (tls.authorized === true && tls.daysUntilExpiry !== null) {
    if (tls.daysUntilExpiry <= 14) {
        issues.push(
          makeIssue({
            severity: "medium",
            title: `TLS certificate expires in ${tls.daysUntilExpiry} day(s)`,
            affected: page,
            whyItMatters: "An expiring certificate that isn't renewed in time causes a hard outage for every visitor - this is one of the most common, entirely preventable production incidents.",
            estimatedImpact: `Certificate valid until ${tls.validTo}.`,
            recommendedFix: "Renew the certificate now, and set up automated renewal (e.g. via ACME/Let's Encrypt) if not already in place.",
            difficulty: "easy",
            source: "measured",
            evidence: [{ type: "computed", label: "Certificate expiry", value: `${tls.validTo} (${tls.daysUntilExpiry} days from now)` }],
          }),
        );
      } else if (tls.daysUntilExpiry <= 30) {
        issues.push(
          makeIssue({
            severity: "low",
            title: `TLS certificate expires within a month (${tls.daysUntilExpiry} days)`,
            affected: page,
            whyItMatters: "Worth scheduling renewal now rather than close to the deadline.",
            estimatedImpact: `Certificate valid until ${tls.validTo}.`,
            recommendedFix: "Renew the certificate, ideally via automated renewal.",
            difficulty: "easy",
            source: "measured",
            evidence: [{ type: "computed", label: "Certificate expiry", value: `${tls.validTo} (${tls.daysUntilExpiry} days from now)` }],
          }),
        );
      }
    }

    if (tls.cipherName && WEAK_CIPHER_PATTERN.test(tls.cipherName)) {
      issues.push(
        makeIssue({
          severity: "high",
          title: `Weak cipher suite negotiated: ${tls.cipherName}`,
          affected: page,
          whyItMatters:
            "This cipher family has known cryptographic weaknesses (broken keystream/hash, undersized block size, or no encryption/authentication at all, depending on which one). This was observed directly from a real TLS handshake, not inferred - the server actually offered and negotiated this cipher.",
          estimatedImpact: `Negotiated cipher: ${tls.cipherName}${tls.protocol ? ` (protocol: ${tls.protocol})` : ""}.`,
          recommendedFix: "Remove this cipher from the server's TLS configuration and rely on modern AEAD ciphers (AES-GCM, ChaCha20-Poly1305).",
          difficulty: "moderate",
          source: "measured",
          evidence: [{ type: "computed", label: "Negotiated cipher", value: tls.cipherName }],
        }),
      );
    }

    if (tls.publicKeyIsRsa && tls.publicKeyBits !== null && tls.publicKeyBits < WEAK_RSA_KEY_BITS) {
      issues.push(
        makeIssue({
          severity: "high",
          title: `TLS certificate uses an undersized RSA key (${tls.publicKeyBits}-bit)`,
          affected: page,
          whyItMatters: `RSA keys below ${WEAK_RSA_KEY_BITS} bits are considered breakable by a well-resourced attacker and fall below the CA/Browser Forum's baseline requirements - this is a real, measured property of the certificate actually presented, not an estimate.`,
          estimatedImpact: `Observed RSA key size: ${tls.publicKeyBits} bits (minimum recommended: ${WEAK_RSA_KEY_BITS}).`,
          recommendedFix: `Reissue the certificate with at least a ${WEAK_RSA_KEY_BITS}-bit RSA key (or switch to a modern EC key, e.g. P-256/P-384, which achieves equivalent-or-better strength at a much smaller key size).`,
          difficulty: "moderate",
          source: "measured",
          evidence: [{ type: "computed", label: "RSA public key size", value: `${tls.publicKeyBits} bits` }],
        }),
      );
    }
  }

  // ---------------- DNS CAA records ----------------
  if (security.caaRecords.probeStatus === "checked" && !security.caaRecords.present) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "No CAA DNS records set",
        affected: page,
        whyItMatters:
          "A CAA (Certification Authority Authorization) DNS record restricts which certificate authorities are allowed to issue certificates for this domain. Most domains don't set one - this is a hardening recommendation, not a vulnerability.",
        recommendedFix: "Consider adding a CAA record (e.g. \"0 issue \\\"letsencrypt.org\\\"\") naming only the certificate authority you actually use.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "computed", label: "CAA records", value: "none found" }],
      }),
    );
  }

  // ---------------- Subresource Integrity ----------------
  if (security.subresourceIntegrity.findings.length > 0) {
    const findings = security.subresourceIntegrity.findings;
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Cross-origin scripts/stylesheets loaded without Subresource Integrity",
        affected: page,
        whyItMatters:
          "Without an integrity attribute, if the third-party host (e.g. a CDN) is compromised or serves different content than expected, this page will execute/apply whatever it sends with no way to detect the tampering.",
        estimatedImpact: `${findings.length} resource(s), e.g. ${findings[0].url}`,
        recommendedFix: "Add an integrity attribute (a sha256/sha384/sha512 hash of the expected file) to each cross-origin <script>/<link rel=stylesheet> tag, or self-host the resource.",
        difficulty: "moderate",
        source: "measured",
        evidence: findings.slice(0, 5).map((f): Evidence => ({ type: "html", label: `Cross-origin <${f.tag}> without integrity`, value: f.url })),
      }),
    );
  }

  // ---------------- Reverse tabnabbing ----------------
  if (security.reverseTabnabbing.findings.length > 0) {
    const findings = security.reverseTabnabbing.findings;
    issues.push(
      makeIssue({
        severity: "low",
        title: 'Links open in a new tab without rel="noopener" (reverse tabnabbing)',
        affected: page,
        whyItMatters:
          'A target="_blank" link without rel="noopener" lets the opened page access window.opener and potentially redirect this tab to a phishing page. Modern browsers mitigate much of the historical risk automatically, but being explicit is still best practice and protects visitors on older browsers.',
        estimatedImpact: `${findings.length} link(s), e.g. "${findings[0].linkText}" -> ${findings[0].url}`,
        recommendedFix: 'Add rel="noopener" (or rel="noreferrer") to every target="_blank" link.',
        difficulty: "easy",
        source: "measured",
        evidence: findings.slice(0, 5).map((f): Evidence => ({ type: "html", label: "target=_blank without noopener", value: `"${f.linkText}" -> ${f.url}` })),
      }),
    );
  }

  // ---------------- Secret exposure (findings already redacted upstream) ----------------
  // Titles/wording deliberately say "PATTERN MATCH" - Insight Web has no
  // way to confirm a matched string is a real, currently-active
  // credential (that would require attempting to USE it, which this
  // tool never does). The distinction between "we matched a pattern"
  // and "we confirmed an active credential" is intentional and load-
  // bearing - see the whyItMatters text below.
  for (const finding of security.secretExposure.findings.slice(0, 5)) {
    issues.push(
      makeIssue({
        severity: finding.confidence === "high" ? "critical" : "high",
        title: `PATTERN MATCH: possible hardcoded credential in publicly served content (${finding.patternName})`,
        affected: page,
        whyItMatters:
          "A publicly reachable credential/API key can be used by anyone who finds it. IMPORTANT: this is a PATTERN MATCH only, not a CONFIRMED ACTIVE CREDENTIAL - Insight Web has not attempted to use this value and cannot confirm it is real, current, or still valid. Treat it as a lead to investigate, not a confirmed breach.",
        estimatedImpact: `Matched pattern "${finding.patternName}" at ${finding.location}. Value redacted: ${finding.redactedPreview}. Confidence: ${finding.confidence}.`,
        recommendedFix:
          "If this is a real credential, rotate/revoke it immediately, then remove it from any publicly served file - use environment variables or a secrets manager on the server side instead of embedding secrets in frontend code.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "html", label: `${finding.patternName} (redacted)`, value: `${finding.redactedPreview} — found at ${finding.location}` }],
      }),
    );
  }

  // ---------------- Dev/staging URL exposure ----------------
  const devUrlsByKind = { localhost: [] as string[], "loopback-ip": [] as string[], "staging-subdomain": [] as string[] };
  for (const f of security.devUrlExposure.findings) devUrlsByKind[f.kind].push(f.url);
  if (devUrlsByKind.localhost.length > 0 || devUrlsByKind["loopback-ip"].length > 0) {
    const combined = [...devUrlsByKind.localhost, ...devUrlsByKind["loopback-ip"]];
    issues.push(
      makeIssue({
        severity: "medium",
        title: "Publicly served content references a localhost/loopback URL",
        affected: page,
        whyItMatters: "A live site referencing localhost/127.0.0.1 usually means a development backend URL was accidentally left in - this typically breaks the referenced functionality for real visitors and can hint at internal architecture.",
        estimatedImpact: `${combined.length} reference(s), e.g. ${combined[0]}`,
        recommendedFix: "Replace the localhost/loopback reference with the correct production URL, and check the build/deploy process for how a dev value ended up in the production bundle.",
        difficulty: "easy",
        source: "measured",
        evidence: combined.slice(0, 5).map((u): Evidence => ({ type: "url", label: "Localhost/loopback reference", value: u })),
      }),
    );
  }
  if (devUrlsByKind["staging-subdomain"].length > 0) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Publicly served content references a staging/dev/test subdomain",
        affected: page,
        whyItMatters: "This may be entirely intentional (e.g. a genuinely separate staging API), but it's worth confirming the reference is meant to be there in production.",
        estimatedImpact: `${devUrlsByKind["staging-subdomain"].length} reference(s), e.g. ${devUrlsByKind["staging-subdomain"][0]}`,
        recommendedFix: "Confirm this reference is intentional; if not, point it at the correct production endpoint.",
        difficulty: "easy",
        source: "measured",
        evidence: devUrlsByKind["staging-subdomain"].slice(0, 5).map((u): Evidence => ({ type: "url", label: "Staging/dev/test subdomain reference", value: u })),
      }),
    );
  }

  // ---------------- CORS ----------------
  if (security.cors.probeStatus === "checked") {
    if (security.cors.reflectsArbitraryOrigin) {
      issues.push(
        makeIssue({
          severity: "high",
          title: "CORS policy reflects an arbitrary Origin header back to the requester",
          affected: page,
          whyItMatters:
            "Reflecting whatever Origin a request sends (instead of validating it against an allowlist) means any website can make cross-origin requests to this endpoint as if it were a trusted origin.",
          recommendedFix: "Validate the Origin header against an explicit allowlist of trusted origins instead of reflecting it back unchecked.",
          difficulty: "moderate",
          source: "measured",
          evidence: [{ type: "header", label: "Access-Control-Allow-Origin", value: `reflected the test Origin we sent ("${security.cors.allowOriginHeader}")` }],
        }),
      );
    } else if (security.cors.wildcardWithCredentialsAttempt) {
      issues.push(
        makeIssue({
          severity: "high",
          title: "CORS wildcard origin combined with Allow-Credentials",
          affected: page,
          whyItMatters:
            "Access-Control-Allow-Origin: * together with Access-Control-Allow-Credentials: true is a contradictory, unsafe combination - compliant browsers reject it, but it signals the CORS configuration was not deliberately reasoned through and may behave unpredictably across clients.",
          recommendedFix: "Use an explicit origin allowlist (never '*') on any endpoint that also sets Allow-Credentials: true.",
          difficulty: "moderate",
          source: "measured",
          evidence: [{ type: "header", label: "Access-Control-Allow-Origin / Allow-Credentials", value: "* combined with true" }],
        }),
      );
    } else if (security.cors.allowOriginHeader === "*") {
      issues.push(
        makeIssue({
          severity: "low",
          title: "CORS allows any origin (Access-Control-Allow-Origin: *)",
          affected: page,
          whyItMatters: "This may be entirely intentional for a public, credential-free API or asset endpoint - but it's worth confirming no sensitive, user-specific data is served from this same origin.",
          recommendedFix: "If this endpoint ever returns user-specific or sensitive data, replace the wildcard with an explicit origin allowlist.",
          difficulty: "easy",
          source: "measured",
          evidence: [{ type: "header", label: "Access-Control-Allow-Origin", value: "*" }],
        }),
      );
    }
  }

  // ---------------- CORS + weakly-scoped cookies (COMBINED risk) ----------------
  // Keep the individual CORS and cookie findings above; this is an additional
  // root-cause correlation only when both measured conditions coexist.
  if (security.cors.probeStatus === "checked" && security.cors.reflectsArbitraryOrigin) {
    const crossSiteSendableSensitiveCookies = security.cookies.findings.filter(
      (c) => c.looksSensitive && c.sameSite === "None" && c.secure,
    );
    if (crossSiteSendableSensitiveCookies.length > 0) {
      issues.push(
        makeIssue({
          severity: "critical",
          title: "Permissive CORS combined with cross-site-sendable session cookies allows unauthorized cross-origin data access",
          affected: page,
          whyItMatters:
            "The CORS policy reflects arbitrary origins while at least one sensitive-looking cookie is both Secure and SameSite=None. Together, a malicious origin can make credentialed cross-origin requests and read the authenticated response.",
          estimatedImpact: `Cookie(s): ${crossSiteSendableSensitiveCookies.map((c) => c.name).join(", ")}.`,
          recommendedFix: "Validate CORS Origin against an explicit allowlist and/or use SameSite=Lax or Strict on these cookies unless genuine cross-site delivery is required.",
          difficulty: "moderate",
          source: "measured",
          evidence: [
            { type: "header", label: "Access-Control-Allow-Origin", value: "reflects arbitrary Origin" },
            ...crossSiteSendableSensitiveCookies.slice(0, 4).map((c): Evidence => ({ type: "header", label: `Cookie \"${c.name}\"`, value: "SameSite=None, Secure=true" })),
          ],
        }),
      );
    }
  }

  // ---------------- Missing HttpOnly + permissive script execution (COMBINED risk) ----------------
  const hasPermissiveScriptExecution =
    !security.csp.present ||
    security.csp.weaknesses.some(
      (w) => w.issue === "unsafe-inline" && HIGH_IMPACT_CSP_DIRECTIVES.has(w.directive),
    );
  if (hasPermissiveScriptExecution) {
    const readableSensitiveCookies = security.cookies.findings.filter(
      (c) => c.looksSensitive && !c.httpOnly,
    );
    if (readableSensitiveCookies.length > 0) {
      issues.push(
        makeIssue({
          severity: "critical",
          title: "Sensitive cookies are readable by JavaScript on a page with permissive script execution",
          affected: page,
          whyItMatters: security.csp.present
            ? "The page allows unsafe inline script execution and at least one sensitive-looking cookie is readable from JavaScript, making cookie theft substantially easier if an XSS bug exists."
            : "The page has no Content-Security-Policy and at least one sensitive-looking cookie is readable from JavaScript, so an XSS bug has no CSP layer to limit script execution.",
          estimatedImpact: `Cookie(s): ${readableSensitiveCookies.map((c) => c.name).join(", ")}.`,
          recommendedFix: "Add HttpOnly to sensitive cookies and use a restrictive CSP without unsafe-inline, using nonces or hashes for required inline scripts.",
          difficulty: "moderate",
          source: "measured",
          evidence: [
            { type: "header", label: "CSP script execution", value: security.csp.present ? "'unsafe-inline' allowed on a high-impact directive" : "no Content-Security-Policy set" },
            ...readableSensitiveCookies.slice(0, 4).map((c): Evidence => ({ type: "header", label: `Cookie \"${c.name}\"`, value: "HttpOnly=false" })),
          ],
        }),
      );
    }
  }

  // ---------------- Information disclosure ----------------
  for (const finding of security.infoDisclosure.findings.slice(0, 6)) {
    const isSecretLike = /\.env|backup\.sql|wp-config|config\.php|\.git\//.test(finding.path);
    const isSourceMap = finding.path.endsWith(".map");
    const isDirListing = finding.note.startsWith("Directory listing");
    const severity: Severity = isSecretLike ? "critical" : isDirListing ? "medium" : isSourceMap ? "medium" : "high";
    issues.push(
      makeIssue({
        severity,
        title: `Potentially sensitive path is publicly accessible: ${finding.path}`,
        affected: new URL(finding.path, page).href,
        whyItMatters: isSecretLike
          ? "Paths like this commonly contain credentials, API keys, or database connection strings - if genuinely exposed, this is a critical, immediately actionable exposure."
          : isSourceMap
            ? "A public source map can reveal original (unminified) source code, comments, and file structure."
            : "This path is commonly left accidentally accessible in production and can expose internal structure or content not meant to be public.",
        estimatedImpact: `HTTP ${finding.statusCode} response observed at this path (content-type: ${finding.contentType ?? "unknown"}).`,
        recommendedFix: isSecretLike
          ? "Remove this file from the publicly served directory immediately and rotate any credentials it may have contained."
          : isSourceMap
            ? "Exclude source maps from production deployments, or restrict access to them."
            : "Confirm this path is intentionally public; if not, remove it from the served directory or restrict access.",
        difficulty: isSecretLike ? "easy" : "moderate",
        source: "measured",
        evidence: [{ type: "url", label: "Path checked", value: `${finding.path} -> HTTP ${finding.statusCode}` }],
      }),
    );
  }

  // ---------------- Debug / development exposure ----------------
  if (security.debugExposure.indicators.length > 0) {
    const hasCodeLevelIndicator = security.debugExposure.indicators.some((i) => !i.startsWith("X-Powered-By") && !i.startsWith("Server header"));
    issues.push(
      makeIssue({
        severity: hasCodeLevelIndicator ? "high" : "low",
        title: hasCodeLevelIndicator ? "Debug/error output appears to be exposed to visitors" : "Server response reveals specific framework/server version information",
        affected: page,
        whyItMatters: hasCodeLevelIndicator
          ? "Stack traces, tracebacks, and framework debug pages can reveal file paths, internal logic, and sometimes credentials or query text - production sites should show a generic error page instead."
          : "Advertising exact framework/server versions makes it easier for an attacker to target known vulnerabilities for that specific version.",
        recommendedFix: hasCodeLevelIndicator
          ? "Disable debug/development mode in production and ensure errors are caught and shown as a generic, non-revealing error page."
          : "Suppress or genericize the Server/X-Powered-By response headers.",
        difficulty: hasCodeLevelIndicator ? "moderate" : "easy",
        source: "measured",
        evidence: security.debugExposure.indicators.slice(0, 5).map((i): Evidence => ({ type: "computed", label: "Debug/version indicator", value: i })),
      }),
    );
  }

  // ---------------- Redirect security ----------------
  if (security.redirectSecurity.crossHostRedirect) {
    issues.push(
      makeIssue({
        severity: "low",
        title: "Request redirects to a different host before serving content",
        affected: page,
        whyItMatters: "A cross-host redirect is often intentional (e.g. a canonical domain or www redirect), but it's worth confirming the destination host is genuinely owned/controlled by the same operator.",
        recommendedFix: "Verify the redirect destination is intentional and controlled by you; point primary links directly at the final host where practical.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "url", label: "Host chain", value: security.redirectSecurity.hostChain.join(" -> ") }],
      }),
    );


  }

  if (security.redirectSecurity.httpProbe.status === "checked" && security.redirectSecurity.httpProbe.redirectsToHttps === false) {
    issues.push(
      makeIssue({
        severity: "high",
        title: "Plain HTTP does not redirect to HTTPS",
        affected: page,
        whyItMatters: "Visitors who type the address without https://, or follow an old http:// link, get an unencrypted connection (or whatever the http:// listener serves) instead of being sent to the secure version of the site.",
        recommendedFix: "Configure the web server/load balancer to redirect all plain HTTP requests to the HTTPS equivalent (a 301 redirect).",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "url", label: "http:// request behavior", value: "did not redirect to an https:// URL" }],
      }),
    );
  }

  return issues;
}
