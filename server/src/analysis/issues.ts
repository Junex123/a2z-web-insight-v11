import type { Evidence, FetchResult, HtmlAnalysis, Issue, Severity } from "../types.js";

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 100,
  high: 70,
  medium: 40,
  low: 15,
};

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function makeIssue(input: Omit<Issue, "id" | "priorityScore">): Issue {
  return {
    ...input,
    id: nextId(input.category),
    priorityScore: SEVERITY_WEIGHT[input.severity],
  };
}

/**
 * Every rule below reads only from MEASURED data (fetch headers/timing,
 * or parsed HTML). Each issue carries the exact evidence that triggered
 * it so the finding is traceable, per the product's core principle.
 */
export function detectIssues(fetchResult: FetchResult, html: HtmlAnalysis): Issue[] {
  const issues: Issue[] = [];
  const page = fetchResult.finalUrl;

  // ---------------- PERFORMANCE ----------------
  const ttfb = fetchResult.timing.approxTtfbMs;
  if (ttfb > 1800) {
    issues.push(
      makeIssue({
        category: "performance",
        severity: "critical",
        title: "Server response time is very slow",
        affected: page,
        whyItMatters:
          "Time to first byte gates every other render metric. Above ~1.8s, users perceive the page as broken before any content paints.",
        estimatedImpact: "Likely pushes Largest Contentful Paint well past the 2.5s 'good' threshold.",
        recommendedFix:
          "Investigate backend response time: enable server-side caching, use a CDN for the HTML document, or profile slow database/API calls in the request path.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "timing", label: "Approx. time to first byte", value: `${ttfb}ms` }],
      }),
    );
  } else if (ttfb > 800) {
    issues.push(
      makeIssue({
        category: "performance",
        severity: "high",
        title: "Server response time is slow",
        affected: page,
        whyItMatters: "A slow TTFB delays every downstream rendering metric, including LCP.",
        estimatedImpact: "Adds directly to Largest Contentful Paint time.",
        recommendedFix: "Add or tune server/edge caching and check for slow upstream API or database calls.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "timing", label: "Approx. time to first byte", value: `${ttfb}ms` }],
      }),
    );
  }

  if (!fetchResult.headers["content-encoding"]) {
    issues.push(
      makeIssue({
        category: "performance",
        severity: "medium",
        title: "HTML response is not compressed",
        affected: page,
        whyItMatters:
          "Uncompressed text responses are typically 60-80% larger than they need to be, slowing every visitor's download.",
        recommendedFix: "Enable gzip or Brotli compression at the web server / CDN / reverse proxy level.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "header", label: "Content-Encoding header", value: "missing" }],
      }),
    );
  }

  if (!fetchResult.headers["cache-control"]) {
    issues.push(
      makeIssue({
        category: "performance",
        severity: "low",
        title: "No Cache-Control header on the document response",
        affected: page,
        whyItMatters: "Without caching directives, browsers and CDNs cannot safely reuse the response for repeat visits.",
        recommendedFix: "Add an appropriate Cache-Control header (even a short max-age for HTML helps under load).",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "header", label: "Cache-Control header", value: "missing" }],
      }),
    );
  }

  if (fetchResult.bodyBytes === 0) {
    issues.push(
      makeIssue({
        category: "performance",
        severity: "critical",
        title: "Empty HTML response",
        affected: page,
        whyItMatters:
          `The server returned HTTP ${fetchResult.statusCode} with a completely empty body. This is NOT a lightweight, fast-loading page - an empty response usually means the page failed to render (a client-side-only app that needs JavaScript execution this scan doesn't perform, a server error that didn't set an error status, or a collection failure). Every other finding on this page should be treated with that in mind, since it's all derived from parsing this same empty content.`,
        recommendedFix: "Load this URL in a real browser and check whether it actually renders content. If it does, the content is likely being injected entirely by client-side JavaScript after load, which this scan cannot see - server-side rendering (or at least a meaningful HTML fallback) would make the page's real content visible to this scan and to search engines.",
        difficulty: "moderate",
        source: "measured",
        evidence: [
          { type: "header", label: "HTTP status", value: String(fetchResult.statusCode) },
          { type: "computed", label: "HTML document size", value: "0 bytes" },
        ],
      }),
    );
  }

  if (fetchResult.bodyBytes > 150_000) {
    issues.push(
      makeIssue({
        category: "performance",
        severity: "medium",
        title: "HTML document is large",
        affected: page,
        whyItMatters: "A large initial HTML payload delays parsing and first render, especially on slow connections.",
        estimatedImpact: `${Math.round(fetchResult.bodyBytes / 1024)}KB of HTML must download before the browser can finish parsing the document.`,
        recommendedFix: "Trim unnecessary inline content, move large inline scripts/styles to cached external files, or paginate/lazy-load content.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "computed", label: "HTML document size", value: `${Math.round(fetchResult.bodyBytes / 1024)}KB` }],
      }),
    );
  }

  if (html.scripts.blockingInHead > 2) {
    issues.push(
      makeIssue({
        category: "performance",
        severity: "high",
        title: "Multiple render-blocking scripts in <head>",
        affected: page,
        whyItMatters: "Scripts loaded in <head> without async/defer block HTML parsing until each one downloads and executes.",
        estimatedImpact: `${html.scripts.blockingInHead} blocking script tag(s) detected in <head>.`,
        recommendedFix: "Add the defer (or async, if order doesn't matter) attribute, or move non-critical scripts to just before </body>.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Blocking <head> scripts", value: String(html.scripts.blockingInHead) }],
      }),
    );
  }

  if (html.stylesheets.blockingInHead > 4) {
    issues.push(
      makeIssue({
        category: "performance",
        severity: "medium",
        title: "Many render-blocking stylesheets",
        affected: page,
        whyItMatters: "Each blocking stylesheet is a round trip the browser must complete before it can paint anything.",
        estimatedImpact: `${html.stylesheets.blockingInHead} blocking stylesheet(s) detected in <head>.`,
        recommendedFix: "Combine stylesheets where practical, or inline critical CSS and defer the rest.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "html", label: "Blocking stylesheets", value: String(html.stylesheets.blockingInHead) }],
      }),
    );
  }

  if (fetchResult.redirected) {
    issues.push(
      makeIssue({
        category: "performance",
        severity: "medium",
        title: "Requested URL redirects before serving content",
        affected: fetchResult.requestedUrl,
        whyItMatters: "Every redirect adds a full network round trip before the browser can start loading the real page.",
        recommendedFix: "Point links and canonical references directly at the final destination URL to remove the redirect hop.",
        difficulty: "easy",
        source: "measured",
        evidence: [
          { type: "url", label: "Requested URL", value: fetchResult.requestedUrl },
          { type: "url", label: "Final URL", value: fetchResult.finalUrl },
        ],
      }),
    );
  }

  // ---------------- Image delivery (root-cause grouped, not per-signal) ----------------
  if (html.images.total > 0) {
    const dimensionsRatio = html.images.missingDimensions / html.images.total;
    const srcsetRatio = html.images.missingResponsiveSrcset / html.images.total;
    // Only surface a signal once it affects a meaningful share of the
    // page's images - a single icon missing width/height isn't worth a
    // finding, and lazy-loading only matters once there are enough
    // images that some are plausibly below the fold (a page with 1-2
    // images likely has its LCP image among them, which should NOT be
    // lazy-loaded - we can't tell which image that is statically, so we
    // only flag "zero lazy hints at all" on pages with enough images that
    // this is very unlikely to be a considered choice).
    const dimensionsSignal = dimensionsRatio >= 0.3;
    const srcsetSignal = html.images.total >= 3 && srcsetRatio >= 0.5;
    const lazyOpportunity = html.images.total >= 6 && html.images.missingLazyLoading === html.images.total;

    if (dimensionsSignal || srcsetSignal || lazyOpportunity) {
      const bullets: string[] = [];
      if (dimensionsSignal) {
        bullets.push(`${html.images.missingDimensions} of ${html.images.total} images are missing explicit width/height attributes (layout-shift risk)`);
      }
      if (srcsetSignal) {
        bullets.push(`${html.images.missingResponsiveSrcset} of ${html.images.total} images have no srcset for responsive delivery`);
      }
      if (lazyOpportunity) {
        bullets.push(`none of the ${html.images.total} images on this page use loading="lazy"`);
      }
      issues.push(
        makeIssue({
          category: "performance",
          severity: dimensionsSignal ? "medium" : "low",
          title: "Image delivery is a performance opportunity",
          affected: page,
          whyItMatters:
            "Images without reserved dimensions can cause layout shift as they load, and images that can't adapt to the viewport or defer off-screen loading add unnecessary weight to the initial page load.",
          estimatedImpact: bullets.join("; "),
          recommendedFix:
            'Add explicit width/height (or a CSS aspect-ratio) to reserve layout space, add loading="lazy" to below-the-fold images (never the largest above-the-fold image), and add srcset where responsive sizing would help.',
          difficulty: "moderate",
          source: "measured",
          evidence: bullets.map((b): Evidence => ({ type: "html", label: "Image delivery signal", value: b })),
        }),
      );
    }
  }

  // ---------------- Third-party resource intelligence ----------------
  if (html.thirdPartyResources.length > 0) {
    const totalThirdPartyRequests = html.thirdPartyResources.reduce((sum, r) => sum + r.count, 0);
    const distinctThirdPartyDomains = html.thirdPartyResources.length;
    if (distinctThirdPartyDomains >= 4 || totalThirdPartyRequests >= 10) {
      const topDomains = html.thirdPartyResources
        .slice(0, 5)
        .map((r) => `${r.host} (${r.category}, ${r.count} ref${r.count === 1 ? "" : "s"})`)
        .join(", ");
      issues.push(
        makeIssue({
          category: "performance",
          severity: distinctThirdPartyDomains >= 8 || totalThirdPartyRequests >= 20 ? "medium" : "low",
          title: "Significant third-party resource usage",
          affected: page,
          whyItMatters:
            "Each additional third-party domain typically adds its own DNS lookup, connection, and TLS handshake, and third-party scripts run outside this site's direct control - together this can meaningfully slow down page load. This is not a judgment that any specific third party listed here is a problem, only that the aggregate overhead is worth reviewing.",
          estimatedImpact: `${distinctThirdPartyDomains} third-party domain(s), ${totalThirdPartyRequests} resource reference(s) total on this page. Top: ${topDomains}.`,
          recommendedFix: "Review third-party scripts/resources for ones that aren't essential, and consider self-hosting, deferring, or lazy-loading non-critical ones (e.g. chat widgets, secondary analytics).",
          difficulty: "moderate",
          source: "measured",
          evidence: html.thirdPartyResources
            .slice(0, 8)
            .map((r): Evidence => ({ type: "html", label: `Third-party host (${r.category})`, value: `${r.host}: ${r.count} reference(s)` })),
          relatedHosts: html.thirdPartyResources.map((r) => r.host),
        }),
      );
    }
  }

  // ---------------- SEO ----------------
  if (!html.title) {
    issues.push(
      makeIssue({
        category: "seo",
        severity: "critical",
        title: "Missing <title> tag",
        affected: page,
        whyItMatters: "The title tag is one of the strongest on-page ranking signals and is what users see in search results and browser tabs.",
        recommendedFix: "Add a unique, descriptive <title> tag (roughly 30-60 characters) to this page.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "<title>", value: "not found" }],
      }),
    );
  } else if (html.titleLength < 30 || html.titleLength > 60) {
    issues.push(
      makeIssue({
        category: "seo",
        severity: "medium",
        title: "Title tag length is outside the recommended range",
        affected: page,
        whyItMatters: "Titles that are too short waste an opportunity to include relevant keywords; titles that are too long get truncated in search results.",
        recommendedFix: "Rewrite the title to fall roughly between 30 and 60 characters while staying descriptive.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Title length", value: `${html.titleLength} characters` }],
      }),
    );
  }

  if (!html.metaDescription) {
    issues.push(
      makeIssue({
        category: "seo",
        severity: "high",
        title: "Missing meta description",
        affected: page,
        whyItMatters: "Without a meta description, search engines auto-generate a snippet, which is usually less compelling and hurts click-through rate.",
        recommendedFix: "Write a unique meta description (roughly 50-160 characters) that summarizes the page and encourages clicks.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "meta[name=description]", value: "not found" }],
      }),
    );
  } else if (html.metaDescriptionLength < 50 || html.metaDescriptionLength > 160) {
    issues.push(
      makeIssue({
        category: "seo",
        severity: "low",
        title: "Meta description length is outside the recommended range",
        affected: page,
        whyItMatters: "Descriptions that are too short under-use the search snippet space; ones that are too long get truncated.",
        recommendedFix: "Adjust the meta description to roughly 50-160 characters.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Meta description length", value: `${html.metaDescriptionLength} characters` }],
      }),
    );
  }

  if (html.h1Count === 0) {
    issues.push(
      makeIssue({
        category: "seo",
        severity: "high",
        title: "No H1 heading found",
        affected: page,
        whyItMatters: "The H1 tells both users and search engines the primary topic of the page.",
        recommendedFix: "Add a single, descriptive H1 heading that summarizes the page's main content.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "H1 count", value: "0" }],
      }),
    );
  } else if (html.h1Count > 1) {
    issues.push(
      makeIssue({
        category: "seo",
        severity: "medium",
        title: "Multiple H1 headings found",
        affected: page,
        whyItMatters: "Multiple H1s dilute the page's topical signal and can confuse both users and search engines about the main subject.",
        estimatedImpact: `${html.h1Count} H1 tags detected: ${html.h1Texts.slice(0, 3).join(" | ")}${html.h1Texts.length > 3 ? "…" : ""}`,
        recommendedFix: "Keep a single H1 for the page's primary heading and demote the rest to H2/H3.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "H1 count", value: String(html.h1Count) }],
      }),
    );
  }

  if (!html.canonicalUrl) {
    issues.push(
      makeIssue({
        category: "seo",
        severity: "medium",
        title: "Missing canonical tag",
        affected: page,
        whyItMatters: "Without a canonical tag, search engines must guess which URL variant to index, which risks duplicate-content dilution.",
        recommendedFix: "Add a <link rel=\"canonical\"> tag pointing to the preferred URL for this content.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "link[rel=canonical]", value: "not found" }],
      }),
    );
  }

  if (html.robotsMeta && /noindex/i.test(html.robotsMeta)) {
    issues.push(
      makeIssue({
        category: "seo",
        severity: "critical",
        title: "Page is set to noindex",
        affected: page,
        whyItMatters: "A noindex directive tells search engines to exclude this page from search results entirely.",
        recommendedFix: "Remove the noindex directive if this page should be discoverable in search, or confirm it is intentional.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "meta[name=robots]", value: html.robotsMeta }],
      }),
    );
  }

  if (!html.hasViewportMeta) {
    issues.push(
      makeIssue({
        category: "seo",
        severity: "high",
        title: "Missing viewport meta tag",
        affected: page,
        whyItMatters: "Without a viewport tag, mobile browsers render a desktop-width layout and scale it down, hurting mobile usability and mobile search ranking.",
        recommendedFix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "meta[name=viewport]", value: "not found" }],
      }),
    );
  }

  if (html.images.total > 0 && html.images.missingAlt > 0) {
    const severity: Severity = html.images.missingAlt / html.images.total > 0.5 ? "high" : "medium";
    issues.push(
      makeIssue({
        category: "seo",
        severity,
        title: "Images missing alt text",
        affected: page,
        whyItMatters: "Alt text helps search engines understand images and is essential for screen-reader accessibility.",
        estimatedImpact: `${html.images.missingAlt} of ${html.images.total} <img> tags have no alt attribute.`,
        recommendedFix: "Add descriptive alt attributes to all meaningful images; use alt=\"\" only for purely decorative images.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "html", label: "Images missing alt", value: `${html.images.missingAlt}/${html.images.total}` }],
      }),
    );
  }

  // ---------------- SECURITY ----------------
  if (!fetchResult.httpsUsed) {
    issues.push(
      makeIssue({
        category: "security",
        severity: "critical",
        title: "Site is not served over HTTPS",
        affected: fetchResult.finalUrl,
        whyItMatters: "Unencrypted HTTP exposes visitors to eavesdropping and tampering, and browsers actively flag HTTP pages as 'Not Secure'.",
        recommendedFix: "Obtain a TLS certificate (e.g. via Let's Encrypt, free) and redirect all HTTP traffic to HTTPS.",
        difficulty: "moderate",
        source: "measured",
        evidence: [{ type: "url", label: "Final URL scheme", value: new URL(fetchResult.finalUrl).protocol }],
      }),
    );
  } else {
    if (!fetchResult.headers["strict-transport-security"]) {
      issues.push(
        makeIssue({
          category: "security",
          severity: "high",
          title: "Missing Strict-Transport-Security (HSTS) header",
          affected: page,
          whyItMatters: "Without HSTS, browsers may still attempt an initial insecure HTTP connection, leaving an opening for downgrade attacks.",
          recommendedFix: 'Add a Strict-Transport-Security header, e.g. "max-age=31536000; includeSubDomains".',
          difficulty: "easy",
          source: "measured",
          evidence: [{ type: "header", label: "Strict-Transport-Security", value: "missing" }],
        }),
      );
    }
    if (html.insecureResourceRefs.length > 0) {
      issues.push(
        makeIssue({
          category: "security",
          severity: "high",
          title: "Mixed content: HTTP resources loaded on an HTTPS page",
          affected: page,
          whyItMatters: "Loading HTTP sub-resources on an HTTPS page breaks the security guarantees of encryption and may be blocked by browsers.",
          estimatedImpact: `${html.insecureResourceRefs.length} insecure resource reference(s) found, e.g. ${html.insecureResourceRefs[0]}`,
          recommendedFix: "Update all resource URLs (images, scripts, styles, iframes) to use https:// or protocol-relative URLs.",
          difficulty: "easy",
          source: "measured",
          evidence: html.insecureResourceRefs.slice(0, 5).map((ref): Evidence => ({ type: "html", label: "Insecure resource", value: ref })),
          relatedHosts: [...new Set(html.insecureResourceRefs.map((ref) => { try { return new URL(ref).hostname; } catch { return null; } }).filter((h): h is string => h !== null))],
        }),
      );
    }
  }

  if (!fetchResult.headers["x-content-type-options"]) {
    issues.push(
      makeIssue({
        category: "security",
        severity: "medium",
        title: "Missing X-Content-Type-Options header",
        affected: page,
        whyItMatters: "Without 'nosniff', some browsers may MIME-sniff responses in ways that enable content-type confusion attacks.",
        recommendedFix: "Add the header X-Content-Type-Options: nosniff.",
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "header", label: "X-Content-Type-Options", value: "missing" }],
      }),
    );
  }

  const hasFrameProtection =
    !!fetchResult.headers["x-frame-options"] ||
    /frame-ancestors/i.test(fetchResult.headers["content-security-policy"] ?? "");
  if (!hasFrameProtection) {
    issues.push(
      makeIssue({
        category: "security",
        severity: "medium",
        title: "No clickjacking protection (X-Frame-Options / frame-ancestors)",
        affected: page,
        whyItMatters: "Without this protection, the page can be embedded in a hidden iframe on a malicious site and used for clickjacking attacks.",
        recommendedFix: 'Add X-Frame-Options: SAMEORIGIN, or a CSP frame-ancestors directive.',
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "header", label: "X-Frame-Options / CSP frame-ancestors", value: "missing" }],
      }),
    );
  }

  if (!fetchResult.headers["content-security-policy"]) {
    issues.push(
      makeIssue({
        category: "security",
        severity: "low",
        title: "No Content-Security-Policy header",
        affected: page,
        whyItMatters: "A CSP reduces the impact of XSS by restricting which sources scripts/styles/resources can load from.",
        recommendedFix: "Introduce a Content-Security-Policy header, starting in report-only mode to avoid breaking existing functionality.",
        difficulty: "hard",
        source: "measured",
        evidence: [{ type: "header", label: "Content-Security-Policy", value: "missing" }],
      }),
    );
  }

  if (!fetchResult.headers["referrer-policy"]) {
    issues.push(
      makeIssue({
        category: "security",
        severity: "low",
        title: "No Referrer-Policy header",
        affected: page,
        whyItMatters: "Without an explicit policy, full URLs (which can contain sensitive query parameters) may leak to third-party sites via the Referer header.",
        recommendedFix: 'Add Referrer-Policy: strict-origin-when-cross-origin (a safe, widely-supported default).',
        difficulty: "easy",
        source: "measured",
        evidence: [{ type: "header", label: "Referrer-Policy", value: "missing" }],
      }),
    );
  }

  return issues;
}

export function resetIssueIdCounter() {
  counter = 0;
}
