# V9 incremental merge note

This build is based on V8. The latest Agent A work was integrated selectively so existing V8 capabilities are not lost. The main promoted work is frontend exposure of already-existing launch decision, verification, correlation, mobile/desktop comparison, prioritized-fix, and report-ID data.

# A-to-Z Web Insight

An evidence-based website intelligence platform. Paste a URL, get a
measured audit — not an AI guess — across Performance, SEO, Security,
and Accessibility, with a prioritized "fix these first" list and full
evidence for every finding.

**Long-term product direction** (not yet implemented — see Roadmap
below): evolve this from a scoring/audit tool into a pre-launch
**verification and approval system** that answers "should this website
go live?" with one of `APPROVED FOR LIVE` / `APPROVED WITH WARNINGS` /
`DO NOT LAUNCH` / `VERIFICATION INCOMPLETE`, backed by explicit
PASS/FAIL/NOT VERIFIED/ERROR/NOT APPLICABLE states per check — never
inferring a PASS from a check that wasn't actually run. This is a
significant reframing of the product surface (decision-oriented, not
just score-oriented) and is intentionally **not started yet**; it's
recorded here so it isn't lost or re-litigated by a future session.
Today, this project is still the scoring/audit MVP described below.

See `PROJECT_PROGRESS.md` for exactly what's built, what's next, and
how to continue development in a future session — treat it as this
project's `PROJECT_STATE.md` (see the short pointer file by that name
in the repo root).

## Roadmap

- [x] **Phase 1 — MVP vertical slice**: real HTTP measurement, HTML
      parsing, deterministic Performance/SEO/Security issue rules,
      severity-based scoring, dashboard, local mock target site.
- [x] **Phase 2 — Real Core Web Vitals**: Google PageSpeed Insights
      integration, normalized evidence, provider abstraction.
- [x] **Phase 3 — Production hardening**: caching, in-flight request
      coalescing, rate limiting, retries, configurable timeouts,
      structured error taxonomy, scan status, logging, SSRF/DNS
      hardening (including IPv4-mapped/NAT64/6to4 IPv6 handling and
      DNS-rebinding protection).
- [x] **Phase 4 — Accessibility analysis engine**: deterministic,
      evidence-backed accessibility checks (see "What's measured
      today"), integrated into the existing finding/severity/scoring/
      pipeline/frontend architecture — no parallel system. Explicit
      "not verifiable by static analysis" disclosure so a clean scan
      is never presented as proof of WCAG compliance.
- [ ] **Phase 5 — Multi-page crawler**: discover and analyze multiple
      pages of a site (not just one URL), reusing the existing
      collector/provider/cache/rate-limit infrastructure rather than
      duplicating it. See `PROJECT_PROGRESS.md` "Next Task" for the
      concrete starting points.
- [ ] **Phase 6+ (unordered, not yet scoped in detail)**: Content, UX,
      Business/Conversion, Competitor Intelligence, and Search
      Visibility analyzers; an AI interpretation layer (summarizes/
      prioritizes existing deterministic findings — never invents new
      measurements); the pre-launch verification/approval reframing
      described above, including per-check PASS/FAIL/NOT VERIFIED/
      ERROR/NOT APPLICABLE states, a launch-blocker-vs-improvement
      split (distinct from the current single severity scale), and a
      confidence dimension separate from severity.

A checkbox above is only ever marked `[x]` once the corresponding work
is implemented, integrated into the existing pipeline (not a parallel
one), tested, and passing typecheck + the full regression suite — see
`PROJECT_PROGRESS.md` for the exact verification record per phase.

## Core principle

> Measurements come from deterministic tools. AI (when added) only
> interprets, prioritizes, and explains — it never invents a number.

Every issue in the report carries an `evidence` array pointing at the
exact HTTP header, HTML tag, or timing value that triggered it. Open
"Raw evidence log" in the dashboard to see the underlying measured
facts behind every score.

## Stack

- **Server**: Node.js 22 + TypeScript (ESM) + Express + Cheerio
- **Frontend**: Vanilla HTML/CSS/JS (static, served by Express) — no
  build step required for the MVP
- **Tests**: Node's built-in test runner (`node:test`) via `tsx`
- No database yet (stateless: scan → return report). No AI calls yet.

## Project structure

```
a2z-web-insight/
  server/
    src/
      types.ts                 # shared data contracts
      collectors/
        httpCollector.ts       # MEASURE step: fetch + timing + headers + SSRF guard
        htmlCollector.ts       # MEASURE step: parse HTML -> SEO/tech facts
        accessibilityCollector.ts # MEASURE step: parse HTML -> accessibility facts
        seoCollector.ts            # MEASURE step: parse HTML -> deep SEO facts (indexability, canonical, OG, hreflang, structured data, images, content)
        robotsCollector.ts         # MEASURE step: fetch + parse robots.txt
        sitemapCollector.ts        # MEASURE step: fetch + parse XML sitemap(s)
        resourceFetcher.ts         # scoped text/XML fetch helper for robots.txt/sitemaps, reusing the SSRF guard
      analysis/
        issues.ts               # ANALYZE step: deterministic HTTP/HTML rules -> Issues
        cwvIssues.ts             # ANALYZE step: Core Web Vitals evidence -> Issues + Factors
        accessibilityIssues.ts   # ANALYZE step: accessibility facts -> Issues + coverage disclosure
        seoIssues.ts              # ANALYZE step: advanced single-page SEO facts -> Issues
        structuredData.ts         # JSON-LD parsing/validation/page-content comparison
        siteSeoAnalysis.ts        # site-wide (multi-page) SEO aggregation - crawler integration point
        scorer.ts                # NORMALIZE step: Issues -> category/overall scores
        performanceThresholds.ts # single source of truth for CWV good/needs-improvement/poor cutoffs
      providers/
        performanceProvider.ts  # PerformanceProvider contract + no-op default
        pageSpeedProvider.ts    # real Google PageSpeed Insights implementation + retry policy
        cachingPerformanceProvider.ts # decorator: caching + in-flight request coalescing
      cache/
        cache.ts                # Cache<T> contract + InMemoryCache implementation
        urlNormalize.ts         # deterministic cache-key normalization
      net/
        retry.ts                # small generic bounded-retry-with-backoff helper
      middleware/
        rateLimit.ts             # in-memory fixed-window per-IP rate limiter
      logging/
        logger.ts                # minimal structured JSON logging, secret-redacting by construction
      routes/
        analyze.ts              # POST /api/analyze
      pipeline.ts               # orchestrates the full SCAN->...->PRIORITIZE flow
      app.ts                    # Express app assembly, rate limiting, error handling
      server.ts                 # entrypoint
    mock-site/
      app.ts                   # local test target website (deliberately imperfect)
      server.ts                # entrypoint to run it standalone
    test/                       # unit + integration tests (197 tests)
  client/
    index.html / styles.css / app.js   # the dashboard
  PROJECT_PROGRESS.md           # continuation state for the next session
  README.md
```

## Running it locally

```bash
cd server
npm install

# Terminal 1: a local "target website" with known issues, for testing/demo
npm run mock-site        # http://localhost:4100 (/messy, /clean, /redirect-me, /slow)

# Terminal 2: the actual app
ALLOW_LOCAL_TARGETS=true npm run dev    # http://localhost:3000
```

Open http://localhost:3000 and scan `http://localhost:4100/messy` or
`http://localhost:4100/clean` to see the pipeline end to end.

`ALLOW_LOCAL_TARGETS=true` is only needed to analyze localhost/private
targets (used for local testing). In production, leave it unset — the
collector blocks loopback/private-IP hosts by default as a basic SSRF
guard (see `src/collectors/httpCollector.ts`).

To analyze a real public site, just run `npm run dev` (without
`ALLOW_LOCAL_TARGETS`) and enter any `https://` URL in the dashboard —
the server needs outbound internet access to reach it.

### Tests

```bash
cd server
npm run typecheck
npm test
```

56 tests: HTML parsing, issue-detection rules, scoring math, PageSpeed
response normalization (mocked - no live Google API calls in
automated tests), CWV-to-issue conversion, and integration tests that
boot both the app and the mock target site and drive real HTTP
requests through the whole pipeline, including verifying the scan
completes successfully when the performance provider fails, times
out, or is rate-limited.

Plus 66 more from the production-hardening pass (122 total): caching
(hit/miss/expiration/never-caching-failures), URL cache-key
normalization, in-flight request coalescing, the generic retry helper,
PageSpeed-specific retry behavior (which failures are/aren't retried),
the rate limiter middleware and its end-to-end wiring into the app,
SSRF/private-network protection (including DNS-rebinding and
redirect-hop re-validation), and scan status (`success`/`partial`/
thrown-on-`failed`).

Plus 18 more from the SSRF/DNS gap-closing pass (140 total, see
`PROJECT_PROGRESS.md` Session 4): representation-independent IPv6
range checks (fixing a real bypass where IPv4-mapped addresses in
canonical hex form slipped past a dotted-decimal-only regex), NAT64/
6to4 embedded-IPv4 detection, obfuscated-IP-literal normalization
proofs, and a genuine end-to-end redirect-loop test (not just a direct
call to the SSRF helper).

Plus 57 more from the Accessibility engine (197 total): collector
tests (each check's raw-fact extraction, false-positive avoidance,
malformed/empty HTML), issue-rule tests (severity assignment, evidence
presence, stable finding IDs across repeated runs), and pipeline
integration tests (accessibility scores and participates in the
overall average, findings appear in `allIssues`/`topPriorityIssues`,
the coverage disclosure is present on every report).

## What's measured today

One HTTP request to the target URL gives us, for free:

- **Performance**: approx. TTFB, total download time, response
  compression, cache headers, HTML document size, render-blocking
  script/stylesheet counts (static analysis), redirect detection,
  plus (see "Sub-resource intelligence" below) real, bounded HEAD-probed
  script/stylesheet/image/font byte sizes, caching/compression on
  those sub-resources, third-party concentration, dev-bundle/source-map
  signals, duplicate library versions, and (when PageSpeed Insights is
  configured) Core Web Vitals plus Lighthouse's own optimization
  opportunities
- **SEO**: title/meta description (presence + length), H1 count,
  canonical tag, robots meta, viewport meta, image alt-text coverage,
  plus (see "Advanced SEO analysis" below) indexability signals,
  deeper canonical analysis, structured data (JSON-LD), Open Graph/
  Twitter metadata, hreflang, image dimensions, content-discoverability
  signals, and a best-effort robots.txt cross-check
- **Security**: HTTPS usage, HSTS, CSP, X-Content-Type-Options,
  X-Frame-Options / frame-ancestors, Referrer-Policy, mixed content
- **Accessibility** (static HTML analysis, evidence-backed — see
  "Accessibility analysis" below for exactly what is and isn't
  verifiable this way): `lang` attribute, image alt text (missing vs.
  intentionally-empty vs. contradictory), form control labels, button/
  link accessible names, heading hierarchy, duplicate ids, ARIA
  reference integrity, invalid ARIA role values, viewport zoom
  restriction, table header structure, iframe titles, autoplaying
  media controls, non-interactive elements with click handlers but no
  keyboard support, and positive `tabindex` values

Plus, when a PageSpeed Insights API key is configured:

- **Core Web Vitals**: LCP, INP, CLS, TTFB, FCP, Speed Index, Total
  Blocking Time, and the Lighthouse performance score — real-user
  (CrUX field) data when Google has enough traffic for the URL,
  falling back to lab data otherwise. Each metric is individually
  marked `good` / `needs-improvement` / `poor` / `unavailable` — never
  a fabricated 0.

**Explicitly out of scope for now** (see the Roadmap above and
`PROJECT_PROGRESS.md`): content analysis, UX, business/conversion
signals, competitor comparison, multi-page crawling, and any
AI-generated interpretation layer.

## Accessibility analysis

**What this checks** (static HTML only — no JavaScript execution, no
rendering, no real assistive-tech testing): `lang` attribute presence,
image alt text (with a real distinction between "no alt attribute at
all" and `alt=""`, which is a *valid* way to mark an image decorative —
only the former is treated as a problem), a decorative-image
contradiction heuristic (`alt=""` combined with `aria-label` or a
non-presentation `role`), form control labeling, button/link
accessible names, heading level hierarchy (skips like H2→H4), duplicate
`id` attributes, broken ARIA references (`aria-labelledby`/
`describedby`/`controls`/`owns` pointing at a nonexistent id),
unrecognized ARIA role values, viewport-disables-zoom, table header
structure, iframe titles, autoplaying media without a pause/mute
mechanism, non-interactive elements with click handlers but no
keyboard path, and positive `tabindex` values.

**What this explicitly does NOT check** — and every report says so
directly (`accessibilityCoverage.notVerifiable` in the API response,
shown in the dashboard's "Accessibility scan coverage" panel), rather
than silently implying a clean scan means WCAG compliance: color
contrast, keyboard traps, focus order, real screen-reader announcement
behavior, whether a syntactically-valid ARIA role is semantically the
*right* role for its context, anything dynamic/JS-driven (this scanner
does not execute JavaScript), and captions/transcripts for audio or
video.

**Deliberate non-duplication with SEO**: missing/empty `<title>` and
missing/multiple `<h1>` are already SEO findings (Session 1) with no
distinct accessibility-specific angle, so they are not duplicated here
— matching real-world convention (Lighthouse categorizes these the
same way) and this project's own precedent (Core Web Vitals TTFB is
not double-scored against the HTTP-measured TTFB finding either).
Image alt text IS intentionally checked under both SEO and
Accessibility — that overlap is legitimate (different audiences,
and Lighthouse does the same) — but Accessibility uses its own
stricter, accessibility-correct definition of "missing" (alt attribute
absent entirely, since `alt=""` is a valid decorative marker) rather
than reusing the SEO layer's broader definition. Viewport-missing
(bare presence) stays an SEO-only finding; Accessibility adds a
distinct, more specific zoom-disabled check that SEO doesn't cover at
all.

## Advanced SEO analysis

Beyond the basic checks listed above (title/description presence and
length, H1 count, canonical presence, viewport, image alt coverage -
all still in `analysis/issues.ts`, unchanged), the SEO category also
covers, per-page:

- **Indexability**, kept distinct from crawlability: meta robots and
  the `X-Robots-Tag` response header are parsed into structured
  directives (`noindex`/`nofollow`/`none`/`noarchive`/`nosnippet`), and
  a genuine conflict between the two (e.g. the tag says `index` but the
  header says `noindex`) is flagged directly.
- **Canonical analysis** beyond "does it exist": relative-vs-absolute,
  malformed hrefs, cross-domain targets, self-reference consistency,
  and multiple/duplicate `<link rel="canonical">` declarations.
- **Structured data (JSON-LD)**: parsed and validated for a
  deliberately small set of high-value schema.org types (Organization,
  WebSite, BreadcrumbList, Article/NewsArticle/BlogPosting, Product,
  Offer, LocalBusiness, FAQPage) - malformed JSON, missing recommended
  properties, duplicate blocks, and (where deterministically
  observable) mismatches between structured data and the page's own
  visible text, e.g. a `Product` schema price that doesn't appear
  anywhere in the visible page content.
- **Open Graph / Twitter card metadata**: presence and og:url-vs-
  canonical consistency.
- **hreflang**: valid language-code format, self-reference presence.
- **Image SEO**: missing width/height attributes (beyond the existing
  alt-text check), generic filenames.
- **Content discoverability**: very little visible text, obvious
  placeholder pages ("coming soon", "under construction", etc.).
- **robots.txt cross-check**: robots.txt is fetched best-effort for
  every scan (`report.robotsTxt`; `available: false` when there isn't
  one - most sites don't, and that's not an error) and the currently-
  scanned page's own path is checked against it.

**Site-wide (multi-page) analysis** - duplicate titles/descriptions
across pages, canonical conflicts (pointing at a noindex/redirecting/
broken page), an internal-link graph (crawl depth from the homepage,
orphan-page detection, broken/redirected/noindex-target internal
links), sitemap-vs-discovered-pages reconciliation, and URL-variant
detection (scheme/www/trailing-slash) - lives in
`analysis/siteSeoAnalysis.ts`'s `analyzeSite()`. This is a **pure
function**, not a crawler: it takes a `SitePageInput[]` (see
`types.ts`) and does no fetching itself. It's the documented
integration point for the multi-page crawler in Roadmap Phase 5 (not
yet built - see `PROJECT_PROGRESS.md`); once that exists, it should
build `SitePageInput[]` from its crawl and call `analyzeSite()` rather
than reimplementing any of this.

**Explicitly not implemented** (see `PROJECT_PROGRESS.md` Session 6):
Microdata/RDFa (JSON-LD only), the full Schema.org spec (only the
high-value types above), and anything requiring JavaScript execution/
rendering (this is static-HTML analysis, same as the rest of the
project - Roadmap's future "browser/runtime verification" phase is
where that would live).

### AI-generated-website SEO failure patterns (Session 7)

`analysis/aiGeneratedSeoIssues.ts` deterministically detects patterns
that are disproportionately common on AI-generated/rapidly-scaffolded
sites launched without a real content pass - generic placeholder
titles/descriptions ("Home | Website", lorem ipsum), development/
staging/localhost URLs leaked into a page's own metadata or sitemap,
a catastrophic `Disallow: /` robots.txt blocking the entire site, and
FAQPage structured data with placeholder or identical answers. Every
finding describes the specific *observable* problem, never a claim
that the site itself was AI-generated.

### Verification states (Session 7)

Beyond severity-tagged Issues, `report.seoVerification` gives an
explicit VERIFIED / FAILED / WARNING / UNVERIFIED / NOT_APPLICABLE
statement for each major SEO area (robots.txt, sitemap, canonical,
indexability, structured data, Open Graph, hreflang) - this exists
specifically so the system never implies something was checked and
passed when it wasn't. Two checks (`duplicate_metadata`,
`internal_link_graph`) are always `unverified` on the current
single-page pipeline, since they genuinely require the multi-page
crawler; see `analysis/seoVerification.ts`'s doc comment.

### Best-effort sitemap fetch

`report.sitemap` is populated per scan from robots.txt's declared
`Sitemap:` URL, or a single conventional `/sitemap.xml` guess as a
fallback. This tries exactly one URL - it is not a discovery process -
so `available: false` means "not found at the one place checked," not
"confirmed absent" (see `seoVerification`'s `sitemap` check for that
distinction stated explicitly).

## Sub-resource intelligence (Session 8)

Beyond the main document's own HTTP response (already fully measured -
TTFB, compression, caching, size), `resourceIntelligence` on every
report covers the SCRIPTS/STYLESHEETS/IMAGES/FONTS that document
references. `collectors/resourceProbe.ts` extracts every candidate
resource URL from the page's HTML and probes up to `RESOURCE_PROBE_MAX`
(default 40, env-configurable) of them with a real, bounded-concurrency
(`RESOURCE_PROBE_CONCURRENCY`, default 6) HTTP HEAD request each -
genuine `Content-Length`/`Cache-Control`/`Content-Encoding`/
`Content-Type` evidence, reusing the same SSRF guard as every other
fetch in this codebase. A resource that couldn't be reached, or whose
cap was hit, is reported as such (`probed: false` / `truncated: true`)
- never silently treated as zero bytes or skipped without a trace.

From that evidence, `analysis/resourceIssues.ts` detects: large
individual resources, excessive total JS/image weight (explicitly
phrased as a floor when the sample is partial), missing compression on
sizable JS/CSS, missing/weak `Cache-Control` on static assets, heavy
third-party concentration (requires both a high request share AND
several distinct origins, to avoid flagging a page that just uses one
or two deliberate services), development-build filenames
(`react.development.js` etc.), exposed source-map references, and
duplicate versions of a handful of well-known libraries (jQuery, React,
Vue, Lodash, Moment, Bootstrap) loaded side by side.

Separately, `analysis/cwvIssues.ts`'s `detectPageSpeedOpportunityIssues()`
turns PageSpeed Insights' own Lighthouse "opportunity" audits
(render-blocking resources, unminified/unused JS or CSS, modern image
formats, etc.) into findings - this data was already being fetched and
normalized but, until this session, never turned into anything visible.

**Explicitly not implemented, and reported as such via
`performanceVerification`'s `browser_runtime` check** (always
`unverified`): actual LCP/CLS/INP/FCP from a real browser render,
confirmed render-blocking behavior, network waterfalls, main-thread
long tasks. This system has no browser/runtime collector. "Render-
blocking" anywhere in its output is either a static HTML signal (no
async/defer on a `<script>` in `<head>`) or a Lighthouse audit finding
from PageSpeed Insights - never a runtime confirmation this system made
itself.

**Root-cause grouping (Session 9)**: rather than one finding per
oversized image, one per missing `loading="lazy"`, and one per missing
`srcset`, related image-optimization symptoms are consolidated into a
single "Image optimization is a significant performance opportunity"
finding, with one evidence line per symptom type underneath. Scripts/
stylesheets/fonts still get individual large-resource findings (no
similarly concrete grouping case for those yet).

**Third-party categorization (Session 9)**: `analysis/thirdPartyCatalog.ts`
matches third-party origins against a small, hand-maintained list of
unambiguous, well-known vendors (Google Analytics, Google Fonts, common
CDNs/tag-managers/chat widgets/etc.) for display purposes only. An
origin not on that list is reported as a bare domain, never guessed at.

## Core Web Vitals / PageSpeed Insights integration

**Setup**: get a free API key at
https://developers.google.com/speed/docs/insights/v5/get-started, then
set `PAGESPEED_INSIGHTS_API_KEY` in your environment (see
`server/.env.example`). No key is hardcoded anywhere in the codebase —
`src/providers/pageSpeedProvider.ts` reads it from `process.env` at
request time, and it is never sent to the frontend or included in the
API response.

**Fallback behavior**: if the key is missing, the request times out,
PageSpeed rate-limits us (HTTP 429), or the API returns something
unusable, the provider resolves to a status other than `"available"`
(`not_configured` / `timeout` / `rate_limited` / `error`) instead of
throwing. **The rest of the scan always completes** — Performance
(from our own HTTP measurements), SEO, and Security are entirely
independent of PageSpeed's availability. The dashboard shows "Core Web
Vitals unavailable for this scan" with the reason, never zeros or
fake numbers.

**Data-source transparency**: every report's `coreWebVitals` field
tells you exactly where the numbers came from:

```jsonc
{
  "coreWebVitals": {
    "providerName": "pagespeed-insights",
    "providerStatus": "available", // or not_configured / rate_limited / timeout / error / unavailable
    "evidence": {
      "strategy": "mobile",
      "lighthousePerformanceScore": 78,
      "metrics": {
        "lcp": { "value": 2600, "unit": "ms", "status": "needs-improvement", "source": "pagespeed-field" },
        "inp": { "value": null, "unit": "ms", "status": "unavailable", "source": "unavailable" }
        // ...
      },
      "opportunities": [{ "id": "render-blocking-resources", "title": "...", "estimatedSavingsMs": 610 }],
      "coverage": { "metricsAvailable": 6, "metricsTotal": 7 }
    },
    "factors": [{ "metric": "lcp", "label": "Largest Contentful Paint", "value": 2600, "status": "needs-improvement", "scoreImpact": -8, "source": "pagespeed-field" }]
  }
}
```

**Architecture**: `PerformanceProvider` (in `src/types.ts`) is the
contract; `PageSpeedProvider` (in `src/providers/pageSpeedProvider.ts`)
is the only implementation today, but a second provider (e.g. a
self-hosted Lighthouse runner) could be added without touching the
scorer, the pipeline's public shape, or the dashboard — they all
depend only on the normalized `CoreWebVitalsEvidence` type, never on
Google's raw JSON response shape. CWV findings feed into the *existing*
severity-based scorer (`analysis/scorer.ts`) via `analysis/cwvIssues.ts`,
which turns poor/needs-improvement metrics into the same `Issue` shape
every other rule produces — no second scoring system was introduced.

## Production hardening

This app accepts arbitrary URLs from the public internet and calls a
metered third-party API on the target's behalf - both of those are
security- and cost-sensitive by nature, so this section documents what
protects the app (and PageSpeed's quota) from abuse or outages.

### Caching (PageSpeed results)

Every successful PageSpeed result is cached in-memory, keyed by a
normalized form of the URL + strategy (scheme/host lowercased, trailing
slash and default port stripped, query params sorted, fragment
dropped - see `src/cache/urlNormalize.ts`). A second scan of "the same
page" within `PAGESPEED_CACHE_TTL` seconds (default 300s) never calls
PageSpeed again; the report marks `coreWebVitals.cached: true` with a
`cacheAgeMs` so the person scanning can see the data isn't brand new.

**Failures are never cached.** A `rate_limited`/`timeout`/`error`
result is not written to the cache, so the very next scan gets a fresh
attempt instead of being "stuck" showing a stale failure for the whole
TTL.

The cache sits behind a tiny `Cache<T>` interface
(`get`/`set`/`delete`) with one implementation today, `InMemoryCache`.
Swapping in Redis or another shared store for a multi-instance
deployment means writing one new class against that interface -
`CachingPerformanceProvider` (the decorator that wraps PageSpeedProvider
with caching) never changes.

### Concurrent request protection

If two scans for the same normalized URL arrive while a PageSpeed call
for that URL is already in flight, the second one **awaits the first
call's promise** instead of firing a duplicate request -
`CachingPerformanceProvider` tracks in-flight calls in a small `Map`.
This is what actually protects PageSpeed quota under real traffic
(caching alone doesn't help until the *first* call has already
finished).

### Rate limiting

`POST /api/analyze` is rate limited per client IP: `ANALYZE_RATE_LIMIT`
requests per `ANALYZE_RATE_WINDOW` seconds (defaults: 30 per 60s).
Exceeding it returns `429` with a `Retry-After` header and a
`retryAfterSeconds` field in the JSON body. It's a simple in-memory
fixed-window limiter (`src/middleware/rateLimit.ts`) - fine for a
single-process deployment; swap for a Redis-backed limiter with the
same middleware signature if this ever runs behind more than one
instance. Tests always construct the app with either an explicit
high/low limit or `rateLimiter: false` (see `createApp` options) so
the automated suite is never flaky against the default limit.

### Timeouts

Every external network call has an explicit timeout and cleanly aborts
rather than hanging: the target-website fetch (`TARGET_FETCH_TIMEOUT`,
default 10s) and the PageSpeed request (`PAGESPEED_TIMEOUT`, default
15s). A timeout never crashes the process - it resolves to a
`TARGET_TIMEOUT` collector error or a `timeout` provider status, which
the pipeline turns into a normal error response / partial report.

### Retries

Only PageSpeed calls retry, and only for genuinely transient failures:
a network-level error (DNS/connection failure) or a 5xx response.
`429`, other 4xx, and malformed responses are **never** retried -
retrying a rate-limit response would make the rate limiting worse, and
retrying a malformed response would just get the same malformed
response again. Timeouts also aren't retried (tripling an already-slow
wait is a bad tradeoff for a synchronous request). Retries are bounded
(`MAX_RETRIES`, default 2) with exponential backoff
(`src/net/retry.ts`) - deterministic and unit-tested via an injectable
sleep function, no real waiting in the test suite. Target-website
fetches are deliberately **not** retried - see
`PROJECT_PROGRESS.md` for why.

### Scan status: success / partial / failed

Every report has a `status` field:

- **`success`** - the target fetch and PageSpeed both completed.
- **`partial`** - the target fetch completed but PageSpeed didn't
  (any non-`available` provider status). Performance/SEO/Security
  scores and every HTTP/HTML-based finding are entirely unaffected -
  only Core Web Vitals are missing, and the dashboard says so plainly.
- **`failed`** - reserved for a target that couldn't be reached at
  all. Today that case throws a `CollectorError` before a report
  object is ever built (see `routes/analyze.ts`'s error mapping)
  rather than returning a report with `status: "failed"` - the type is
  kept for a future batch/crawl mode that would want to represent it
  inline instead of throwing.

### Error model

Internal errors use a small, specific set of codes rather than generic
strings, and every message reaching the client is hand-written to be
safe to show (no stack traces, no file paths, no API keys):

| Code | Meaning | HTTP status |
|---|---|---|
| `INVALID_URL` | not a valid/supported URL | 400 |
| `BLOCKED_HOST` | SSRF guard rejected the host | 400 |
| `DNS_ERROR` | hostname could not be resolved | 502 |
| `TARGET_TIMEOUT` | target site didn't respond in time | 504 |
| `TARGET_UNREACHABLE` | network failure, too many redirects, oversized body | 502 |
| `NON_HTML` | target didn't return an HTML response | 415 |
| `RATE_LIMITED` | too many requests from this IP | 429 |
| `PAYLOAD_TOO_LARGE` / `BAD_REQUEST` | malformed/oversized request body | 413 / 400 |
| `INTERNAL_ERROR` | unexpected server-side failure | 500 |

PageSpeed-side failures use the separate `ProviderStatus` enum
(`available` / `rate_limited` / `timeout` / `error` / `not_configured`
/ `unavailable`) rather than a second parallel error-code system -
see the Architecture Decisions in `PROJECT_PROGRESS.md` for why.

### Security: SSRF / private-network protection

This app fetches arbitrary user-supplied URLs, which is a classic SSRF
surface - treated accordingly:

- Hostname pattern checks reject `localhost`, `.local`, and bare
  `0.0.0.0`.
- A **DNS-rebinding guard** resolves the hostname and checks the
  actual IP(s) against RFC1918/loopback/link-local/CGNAT/multicast
  ranges (both IPv4 and IPv6) - this catches a public-looking hostname
  that resolves to an internal address (e.g. the cloud metadata
  endpoint `169.254.169.254`), which a hostname-string-only check
  would miss.
- **Every redirect hop is re-validated**, not just the initial
  request - the collector follows redirects manually (`redirect:
  "manual"` + its own loop, capped at 5 hops) specifically so a page
  that redirects to an internal address is rejected instead of
  silently followed there.
- Request bodies are capped at 100kb; oversized/malformed JSON bodies
  return a clean `413`/`400` instead of crashing the process.
- `ALLOW_LOCAL_TARGETS=true` bypasses all of the above, for local
  development and the bundled mock-site tests only - **it must never
  be set in production**. It exists so the exact same collector code
  used for real scans can also be exercised against a local test
  target without maintaining a second code path.

### Observability

Key events are logged as single-line JSON via `src/logging/logger.ts`:
`scan_started`, `scan_completed`, `scan_failed`, `cache_hit`,
`cache_miss`, `pagespeed_request`, `pagespeed_failure`,
`rate_limit_rejected`. Every log line includes a timestamp and
relevant identifiers (report ID, normalized URL/cache key, duration,
status) - never an API key, auth header, or cookie (field names
matching `key`/`token`/`secret`/`password`/`authorization`/`cookie`
are redacted automatically before the line is ever written, so a
future call site can't accidentally leak a secret into the logs).

## Development mock target site

`server/mock-site/` is a small Express app with routes that have known,
deliberate issues (`/messy`), a clean baseline (`/clean`), a redirect
(`/redirect-me`), and an artificially slow response (`/slow`). It
exists because this kind of app can't be tested end-to-end against
*real* arbitrary websites in every environment (e.g. a sandboxed CI
runner with restricted network egress), and because it gives fast,
deterministic regression coverage that doesn't depend on any external
site staying online or unchanged. Run it with `npm run mock-site`;
point the dashboard at it with `ALLOW_LOCAL_TARGETS=true` set on the
main app.



- Deterministic pipeline and AI interpretation are architecturally
  separate on purpose — `analysis/` never calls an LLM. When AI
  interpretation is added, it will consume `Issue[]` as input and
  produce summaries/explanations only, never new measurements.
- Score model is intentionally simple and transparent: each category
  starts at 100 and loses fixed points per issue severity
  (critical -25, high -15, medium -8, low -3), floored at 0. Overall
  is the mean of category scores. This is easy to explain to a user
  and easy to unit test — see `analysis/scorer.ts`.
