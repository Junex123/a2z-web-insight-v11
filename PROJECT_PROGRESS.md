# Current Project State

_(This file is this project's `PROJECT_STATE.md` — there's a one-line
pointer file at that exact path in the repo root for any session that
looks for it by that name specifically.)_

## Session 9 — Performance Phase 2b: root-cause grouping, image-attribute signals, third-party categorization

**Context**: this task ("Agent 5 - Hamza") arrived as essentially a
restatement of Session 8's brief, without the fictional-baseline claims
that session had to push back on. Repository was already at Session 8's
state (398 tests) when this session started - verified before writing
anything. Rather than redo Session 8's work, this session identified
and built only the genuinely new pieces the brief emphasized that
Session 8 hadn't covered: **root-cause grouping** (an explicit
instruction with a concrete worked example - "12 oversized images + 8
missing lazy-loading + 6 missing width/height" should become ONE
finding, not ten), image `loading`/`srcset` signals, and third-party
vendor categorization.

**What was added:**

- **`src/analysis/thirdPartyCatalog.ts`** (new) - a small, deliberately
  hand-maintained list of ~35 unambiguous, well-known third-party
  domains (Google Analytics, GTM, Google Fonts, cdnjs/jsDelivr/unpkg,
  Intercom, YouTube, Stripe, Sentry, etc.) mapped to a category
  (analytics/advertising/tag-manager/social/fonts/cdn/chat/video/
  payment/monitoring) + display label. `categorizeThirdPartyOrigin()`
  only ever matches by exact/subdomain match against this list -
  returns `null` for anything else. Explicitly NOT an attempt at
  inferring vendor identity from a domain's name/shape, per the task's
  own repeated instruction not to guess.
- **`collectors/resourceProbe.ts`**: `ResourceIntelligence.thirdParty
  .origins` changed from a bare `string[]` to `ThirdPartyOriginInfo[]`
  (origin + requestCount + knownBytes + category + vendorLabel, the
  latter two `null` when uncategorized) - categorization happens once,
  at collection time, so every consumer (the third-party-concentration
  Issue, any future dashboard) gets it for free instead of
  re-looking-it-up. This is the one shape change this session made to
  an existing (Session-8-introduced, not yet "released" beyond this
  same body of work) type.
- **`analysis/resourceIssues.ts`**:
  - `extractImageAttributeFacts()` (new, exported) - pure HTML parsing
    (no HTTP) of every `<img>`'s `loading`/`srcset`/declared
    width+height, in DOM order.
  - `detectImageOptimizationOpportunity()` (new) - the root-cause-
    grouping implementation. Correlates three signals - oversized
    images (real probed bytes >=150KB), images beyond the first 3
    (a deliberately rough above-the-fold heuristic) missing
    `loading="lazy"`, and oversized images with no `srcset` - into
    **one** "Image optimization is a significant performance
    opportunity" Issue when 2+ symptom types are present, with one
    evidence line per symptom type (count + one concrete example),
    not one line per image. Severity scales with how much oversized-
    image weight is involved. This REPLACES per-image "Large image
    resource" reporting entirely (`detectLargeResources()` now skips
    `kind: "image"` - a real type-checker-caught bug from removing
    that path was fixed immediately: a dead `entry.kind === "image"`
    branch in the *script/stylesheet* recommendation text, which
    `tsc` correctly flagged as unreachable after the `continue`).
    Scripts/stylesheets/fonts keep their existing per-entry large-
    resource reporting from Session 8 - the task's own grouping
    example was specifically about images, so this session didn't
    extend grouping to the other kinds without a similarly concrete
    justification.
  - Third-party-concentration evidence now includes vendor labels
    where known (e.g. "google-analytics.com (Google Analytics)")
    instead of a bare domain list.

**What was deliberately NOT done:** ETag/Last-Modified/Expires-specific
caching rules beyond what Session 8 already checks (Cache-Control
presence/max-age) - `ResourceProbeEntry.etag` was already captured in
Session 8 but isn't yet used by a dedicated rule; recorded here as a
real, small remaining gap rather than silently addressed. No
`<picture>`-element analysis (only `<img srcset>` - `<picture><source>`
variants are a distinct, unimplemented pattern). No grouping for
scripts/stylesheets, per above. No browser/runtime work, no crawler,
no site-wide aggregation - same boundaries as Session 8, still
correctly out of scope.

**Honest verification status - same sandbox limitation as every prior
session:** no `node_modules`, no registry access. Same mitigation as
before: vendored `typescript`+`@types/node` and temporary `cheerio`/
`express` `.d.ts` stubs, ran `tsc --noEmit`. This run actually caught a
real bug (the dead `"image"` branch noted above) before it could ship -
concrete evidence the typecheck pass, while not a substitute for
running the real suite, is still doing real work each session. Zero
remaining errors in any file this session touched after the fix; all
other errors were the same pre-existing `Response`-shape artifact in
files this session didn't touch. Stub `node_modules` deleted
afterward. **Still not a substitute for an actual `npm install && npm
test`.**

New tests this session: 10 (in `test/resourceIssues.test.ts` and
`test/resourceProbe.test.ts` - no dedicated `thirdPartyCatalog.test.ts`
file was created; `categorizeThirdPartyOrigin()` is covered directly by
two tests inside `resourceIssues.test.ts` plus indirectly by every
third-party-concentration test). Total tests in the repository: 408 -
counted directly, not confirmed by an actual run.

## Session 8 — Performance Phase 2: real sub-resource intelligence, PageSpeed opportunities, performance verification states

**Context**: same pattern as Session 7 - the task prompt ("Agent 5 /
Hamza") described a fictional baseline (486/486 tests, `/api/analyze-site`,
a browser/runtime collector, `sitePipeline.ts`) that doesn't exist in
this repository. Flagged back explicitly; confirmed answer: proceed
against the real checkout (344 tests at the time, no `/api/analyze-site`,
no browser/runtime collector, no crawler), treat the described baseline
as target/future information only, never fabricate it. Everything below
honors that - in particular, there is genuinely no browser/runtime
measurement anywhere in this work; every new capability is either a
real bounded HTTP HEAD probe this session added, or real PageSpeed
Insights/Lighthouse data that was already being fetched but was
sitting unused.

**Gap analysis performed before writing any code** (per the task's own
instruction): read `cwvIssues.ts`, `pageSpeedProvider.ts`,
`htmlCollector.ts`, `httpCollector.ts`, `issues.ts`'s existing
performance rules, and the full existing test suite first.

- IMPLEMENTED already: Core Web Vitals via PageSpeed Insights (real
  field/lab data, never fabricated), main-document compression/caching
  checks, blocking-script/stylesheet-in-`<head>` counts, HTML document
  size.
- PARTIAL: `pageSpeedProvider.ts` already parsed Lighthouse's
  `opportunities` (render-blocking resources, unminified JS/CSS, unused
  JS/CSS, modern image formats, text compression, long cache TTL,
  etc.) into a normalized array - but **nothing ever turned that array
  into an Issue.** This was a genuine, real gap, not something to
  rebuild: the data was already there, unused.
- GENUINELY MISSING: any intelligence about the page's own SUB-resources
  (scripts/stylesheets/images/fonts) beyond the DOM-structure-only facts
  `htmlCollector.ts` already had (blocking-in-head counts). No actual
  byte sizes, no caching/compression evidence, no third-party grouping,
  anywhere.
- REQUIRES BROWSER (not implemented, correctly left as such): actual
  LCP/CLS/INP/FCP/TTFB from a real render, confirmed render-blocking
  behavior, network waterfalls, main-thread long tasks, runtime layout
  shift attribution. None of this exists in this checkout and none of
  it was fabricated here.
- REQUIRES CRAWLER/SITE AGGREGATION (not implemented, correctly left as
  such): "average page weight across N pages," "slowest page,"
  cross-page repeated-resource detection. No `sitePipeline.ts` exists;
  Session 6's `analyzeSite()` precedent (SEO) - a pure aggregation
  function waiting for a crawler - was not duplicated here since there
  is no equivalent multi-page performance need to express yet without
  real pages to feed it.

**What was added - all genuinely new, all still single-page-scoped:**

- **`src/collectors/resourceProbe.ts`** (new) - the main addition this
  session. Extracts every script/stylesheet/image/font URL a page's
  HTML actually references (`extractCandidateResources()`, pure, no
  I/O) and probes up to `RESOURCE_PROBE_MAX` (default 40) of them with
  a real, bounded-concurrency (`RESOURCE_PROBE_CONCURRENCY`, default 6)
  HTTP HEAD request each, via a new `fetchResourceHead()` in
  `collectors/resourceFetcher.ts` that reuses the exact same SSRF guard
  (`assertHostAllowed`) as every other fetch in this codebase - not a
  new/weaker one. Every Content-Length/Cache-Control/Content-Encoding/
  Content-Type in the result came from an actual HTTP response; a
  resource that couldn't be reached, or whose cap was hit, is `probed:
  false` / absent - never defaulted to a guess. `ResourceIntelligence`
  (new, additive type) aggregates this into per-kind totals (with
  explicit `sizeKnownCount` vs `count` so partial coverage is never
  silently presented as complete) and a third-party breakdown (grouped
  by registrable host, www-insensitive).
- **`src/analysis/resourceIssues.ts`** (new) - turns
  `ResourceIntelligence` into Issues: large individual resources (by
  kind-specific thresholds), excessive total JS/image bytes (explicitly
  phrased as "at least Xkb" when the sample is partial), missing
  compression on sizable JS/CSS, missing/weak `Cache-Control` on static
  assets (an explicit `no-store` is treated as an intentional choice,
  not flagged), heavy third-party concentration (requires BOTH a high
  request share AND several distinct origins, to avoid flagging a page
  that just uses one or two deliberate services - direct response to
  the task's "Area 17 False Positive Control"), development-build
  filenames (`.development.js` etc.), exposed source-map references
  (inline `sourceMappingURL` comments, directly-linked `.js.map`), and
  duplicate library versions (jQuery/React/Vue/Lodash/Moment/Bootstrap,
  via filename+version regex - intentionally small, literal, low-noise
  list rather than a general "duplicate code" claim). Own id prefix
  `performance-res-N`.
- **`src/analysis/cwvIssues.ts`** (extended, not replaced) -
  `detectPageSpeedOpportunityIssues()`: turns the previously-unused
  `opportunities` array into Issues, filtered to a materiality
  threshold (>=250ms estimated savings) so trivial Lighthouse
  nitpicks don't flood the report. Own id prefix `performance-opp-N`
  (separate counter from the existing `performance-cwv-N` metric
  issues, so `resetCwvIssueIdCounter()` now resets both).
- **`src/analysis/performanceVerification.ts`** (new) - the
  VERIFIED/FAILED/WARNING/UNVERIFIED/NOT_APPLICABLE model the task
  asked for, mirroring Session 7's `seoVerification.ts` exactly (same
  `VerificationState` type, reused as-is - see its updated doc comment
  in `types.ts`, which now documents the "one shared state type, one
  `<Category>VerificationCheck` type per category" pattern for future
  sessions). Three checks: `core_web_vitals` (verified/not_applicable/
  unverified depending on the provider's actual status - never
  "verified" just because a key happened to be configured),
  `resource_probe` (verified only when every candidate was actually
  reached with no truncation; warning when the cap was hit or some
  resources timed out - the coverage gap is stated, not hidden), and
  `browser_runtime` (hardcoded `unverified` - correctly, since this
  checkout has no browser/runtime collector at all).
- **`types.ts`** (extended, not modified): `ResourceKind`,
  `ResourceProbeEntry`, `ResourceKindTotals`, `ResourceIntelligence`,
  `PerformanceVerificationCheck`, `PerformanceVerificationSummary` all
  new/additive. `AnalysisReport` gained `resourceIntelligence` and
  `performanceVerification` - every existing field untouched.
- **`pipeline.ts`**: wires `collectResourceIntelligence()` (own
  try/catch safety wrapper, same "never take down the whole scan"
  pattern as the performance provider/robots.txt/sitemap calls),
  `detectResourceIssues()`, `detectPageSpeedOpportunityIssues()`, and
  `buildPerformanceVerificationSummary()` in alongside the existing
  steps.

**What was deliberately NOT done:**

- No browser/runtime collector, no fabricated Core Web Vitals, no
  fabricated render-blocking confirmation, no fabricated network
  waterfall - all correctly `unverified`/absent rather than invented.
- No `sitePipeline.ts`/crawler, no cross-page aggregation - single-page
  scope only, as instructed.
- No change to `analysis/issues.ts`'s existing main-document
  compression/caching/blocking-in-head checks - `resourceIssues.ts` is
  entirely about SUB-resources' own response evidence, a genuinely
  different, non-overlapping fact set.
- No new dependencies.

**Honest verification status - same sandbox limitation as Sessions 6
and 7:** no `node_modules`, no package-registry network access this
session either. Mitigated identically: vendored a compatible
`typescript`+`@types/node` and temporary throwaway `cheerio`/`express`
`.d.ts` stubs from elsewhere on the machine, ran `tsc --noEmit`, then
deleted the stub `node_modules` afterward. Result: **zero type errors
in any file this session touched.** Every remaining error was the same
pre-existing `Response`-type-shape artifact from the vendored
`@types/node` version (identical in `httpCollector.ts`,
`pageSpeedProvider.ts`, and pre-existing test files this session didn't
touch) or a gap in the throwaway stubs themselves (fixed once found -
e.g. the stub's `Response.set()` needed a two-argument overload to
match how the pre-existing test suite already calls it). **This is
still not a substitute for an actual `npm install && npm test`, which
this session could not perform.**

New tests this session: 54 (4 new files -
`test/resourceProbe.test.ts`, `test/resourceIssues.test.ts`,
`test/performanceVerification.test.ts`,
`test/performancePipeline.test.ts` - plus 6 additions to the existing
`test/cwvIssues.test.ts` for `detectPageSpeedOpportunityIssues()`).
Combined with the 344 tests already in the checkout at the start of
this session, the repository now has 398 tests total - counted
directly (`grep -c "^test("` across every `test/*.test.ts` file), not
confirmed by an actual run. If a future session's `npm test` reports a
different number, trust that number, not this one.

**Known limitations / what still requires the future crawler or a
browser, stated plainly (not silently dropped):**
- Resource probing is single-page and bounded (default cap 40
  candidates, prioritizing scripts/stylesheets/fonts over images) -
  `ResourceIntelligence.truncated` and `candidateCount` vs
  `probedCount` make partial coverage explicit; a page with more
  sub-resources than the cap will under-report its true total weight,
  and `performanceVerification`'s `resource_probe` check says so
  (`warning`, not `verified`).
- No actual LCP/CLS/INP/FCP/TTFB from a real browser render - only
  PageSpeed Insights' own Lighthouse-run figures (when configured) and
  our own direct TTFB measurement (already existed, Session 1).
- "Render-blocking" anywhere in this session's output is a static HTML
  signal (no async/defer on a `<script>` in `<head>`) or a Lighthouse
  audit finding, never a runtime confirmation that a resource actually
  blocked paint.
- Third-party classification is origin-only (no vendor-name
  guessing/inference) - a domain the person doesn't recognize is
  reported as a domain, not labeled "likely an ad network" or similar.
- Site-wide performance aggregation ("average page weight across N
  pages," repeated-resource detection across pages) does not exist -
  same as SEO's site-wide layer, this needs the still-nonexistent
  crawler.

**Evidence exposed for a future cross-domain-correlation layer**
(without implementing any correlation/launch-decision logic itself,
per the task's explicit instruction): `resourceIntelligence.entries`
carries per-resource scheme (derivable from the URL) for a future
mixed-content-style check; `thirdParty.origins` is ready for a future
security-side "is this a known-risky third party" cross-check;
`performanceVerification` + `seoVerification` (Session 7) now share
one `VerificationState` shape, so a future Security/Accessibility
verification summary (if ever added) has a template to follow rather
than inventing a third shape.

## Session 7 — SEO Phase 2: AI-generated-site failure patterns, verification-state model, link/sitemap wiring

**Context**: the person's task prompt for this session described a
fictional "6-agent merged Insight Web baseline" (named agents Godeels/
Fambruh/Junex/Akila/Hamza/Agent A, an existing crawler, graph-based
verification states, etc.) that does not exist anywhere in this repo.
This was flagged back to the person explicitly rather than fabricated;
their follow-up confirmed: keep working on THIS real repository, on the
real architecture (`collectHttp -> collectHtml/collectSeoExtras ->
issues -> scorer -> pipeline`), treat the 6-agent framing as a future
plan/naming convention only, and do not invent a crawler, other agents'
modules, or site-wide evidence that the current single-page pipeline
cannot actually produce. Everything below honors that.

**What was added, all still single-page-scoped except where noted:**

- **`src/collectors/seoCollector.ts`**: added `PageLinkFacts` extraction
  (`seo.links`) - internal (same-site, www-insensitive, deduped,
  resolved-absolute) vs external link counts for THIS page only, via a
  third `cheerio.load()` pass in the same function. Explicitly documented
  as not a crawl graph. `analysis/siteSeoAnalysis.ts`'s doc comment now
  notes the future crawler can reuse `seo.links.internal` directly as
  `SitePageInput.internalLinks` instead of re-parsing.
- **`src/analysis/seoIssues.ts`**: one new check, "Page has no internal
  links" (medium), gated on the page having >=200 chars of visible text
  so it doesn't pile onto pages already flagged thin/placeholder.
- **`src/collectors/robotsCollector.ts`**: added `isSiteWideBlocked()` -
  narrowly detects `User-agent: *` + `Disallow: /` with no `Allow`
  carve-out (the literal "entire site blocked" catastrophe), distinct
  from any broader-but-legitimate Disallow rule.
- **`src/analysis/aiGeneratedSeoIssues.ts`** (new, isolated module - own
  id prefix `seo-ai-N`, own file per the task's "prefer isolated SEO
  modules" instruction): deterministic detection of patterns common on
  AI-generated/rapidly-scaffolded sites, always describing the
  *observable* failure, never asserting the site was AI-made:
  - generic placeholder titles ("Home | Website", "Untitled Document",
    lorem ipsum, etc.) and placeholder meta descriptions
  - development/staging/local URLs leaked into a page's OWN metadata
    (canonical, og:url/og:image, twitter:image, hreflang hrefs,
    JSON-LD url/@id/sameAs/image/logo fields) - checks against
    localhost/127.0.0.1/bare-IP/`.local`/`staging.`/`dev.`/`test.`/
    `preview.` and common ephemeral-preview hosts (vercel.app,
    netlify.app, ngrok, repl.co, etc.) - CRITICAL severity
  - the catastrophic robots.txt block above, surfaced as an Issue -
    CRITICAL
  - a fetched sitemap (see below) whose own URLs point at those same
    dev/staging hosts - CRITICAL
  - FAQPage JSON-LD with identical or obviously-placeholder answers
  - a handful of placeholder-looking URL slug patterns
    (`lorem-ipsum`, `test-page`, `undefined`, etc.) - kept deliberately
    small and literal to avoid false-positiving on legitimate URLs
- **`src/collectors/sitemapCollector.ts` wired into the pipeline** (the
  collector itself already existed from Session 6 but was unused):
  `pipeline.ts` now does ONE best-effort sitemap fetch per scan - the
  URL robots.txt declared via `Sitemap:`, or failing that a single
  conventional `/sitemap.xml` guess. This is explicitly not a crawl:
  exactly one URL is tried, and a miss is reported as `unverified`
  (see below), never as "confirmed no sitemap." Feeds the new
  dev-host-in-sitemap check above.
- **`src/analysis/seoVerification.ts`** (new) + `VerificationState`/
  `SeoVerificationCheck`/`SeoVerificationSummary` types (new, additive
  only) in `types.ts`: the small, SEO-scoped VERIFIED/FAILED/WARNING/
  UNVERIFIED/NOT_APPLICABLE model the task asked for, deliberately
  implemented as a *separate* reporting structure
  (`report.seoVerification`) rather than a change to the shared
  `Issue`/`Severity` contract every other category also uses - see that
  file's top-of-file doc comment for the reasoning. Nine checks per
  scan (`robots_txt`, `sitemap`, `canonical`, `indexability`,
  `structured_data`, `open_graph`, `hreflang`, plus two that are
  **always** `unverified` on this single-page pipeline:
  `duplicate_metadata` and `internal_link_graph`, both requiring the
  still-nonexistent crawler). Two designed distinctions worth knowing:
  robots.txt has exactly one canonical location, so a confirmed-404
  there genuinely IS `verified` ("no robots.txt exists"); a sitemap has
  no such guarantee, so a miss there is `unverified`, not `verified`.
  Structured-data's `verified` detail explicitly disclaims rich-result
  eligibility (syntactic validity only, per the task's own instruction
  not to overclaim Google eligibility).
- **`AnalysisReport`** gained two more additive fields:
  `report.sitemap` (the best-effort `SitemapAnalysis`) and
  `report.seoVerification`. Nothing existing was removed or changed
  shape.

**Shared-contract changes and why** (kept intentionally small,
per the task's explicit instruction not to do a "massive architecture
rewrite" for the verification-state model):
- `types.ts`: additive only - `PageLinkFacts` (new field on the
  already-additive `SeoExtendedAnalysis` from Session 6),
  `VerificationState`/`SeoVerificationCheck`/`SeoVerificationSummary`
  (new types, not touching `Issue`/`Severity`), two new optional-in-spirit
  (but always-populated) fields on `AnalysisReport`.
- `pipeline.ts`: wires the sitemap fetch, the AI-generated-failures
  detector, and the verification-summary builder in alongside the
  existing steps - same "gather everything, never let one collector's
  failure take down the scan" pattern as the performance provider and
  robots.txt fetch already established in Session 6.
- No change to `collectHtml`, `analysis/issues.ts`, `mock-site/app.ts`,
  or any other agent's (future) area.

**Honest verification status - same sandbox limitation as Session 6:**
no `node_modules`, no package-registry network access
(`npm install` -> `403`/`ENOTCACHED` again this session). Mitigated the
same way: vendored a compatible `typescript`+`@types/node` from a
globally-installed package elsewhere on the machine, wrote temporary
throwaway `.d.ts` stubs for `cheerio`/`express` covering the surface
this project actually uses, ran `tsc --noEmit`, then deleted the stub
`node_modules` afterward (not part of the real deliverable - a real
`npm install` will pull the actual packages). Result: **zero type
errors in any file touched this session** (or Session 6's files).
Every remaining error was a pre-existing, unrelated artifact of the
vendored `@types/node` version's `Response` type shape disagreeing with
this project's pinned version (identical in `httpCollector.ts`,
`pageSpeedProvider.ts`, and several pre-existing test files - none of
which this session touched) or a gap in the throwaway stubs themselves.
**This is still not a substitute for an actual `npm install && npm
test`, which this session could not perform either.** Do not trust
this note over an actual test run - go run it.

New tests this session: 53 across the SEO test suite (2 new files,
`test/aiGeneratedSeoIssues.test.ts` and `test/seoVerification.test.ts`,
plus additions to `seoCollector.test.ts`, `seoIssues.test.ts`,
`robotsCollector.test.ts`, and `seoPipeline.test.ts`). Combined with
Session 6's 94, the SEO-specific test files now total 147 tests -
again, counted directly from the files, not confirmed by an actual test
run.

**What's still explicitly UNVERIFIED / out of scope, and why** (per the
task's own "never turn not-checked into PASS" instruction - this is
also exactly what `report.seoVerification` now states in-band on every
scan, not just in this doc):
- Duplicate titles/descriptions across the site, orphan pages, crawl
  depth, sitewide canonical conflicts - all require multiple pages.
  `analysis/siteSeoAnalysis.ts` (Session 6) already implements every one
  of these as a pure function; it has no pages to analyze until the
  crawler exists. Do NOT build that crawler "just to satisfy" this SEO
  work - that was explicit in this session's instructions.
  duplicate/near-duplicate BODY content (as opposed to titles/
  descriptions) is not implemented anywhere yet - flagged here as a real
  gap, not silently dropped.
- Sitemap completeness: only one URL is ever tried (robots.txt-declared
  or the conventional guess); a miss is `unverified`, not "no sitemap."
  If a real sitemap exists at a nonstandard, undeclared path, this scan
  will not find it.
- Structured-data "validity" here means syntactic JSON-LD validity plus
  a small recommended-property checklist - never an assertion of actual
  Google rich-result eligibility, which depends on additional
  Google-side criteria outside what static analysis can determine.
- AI-generated-pattern detection is inherently a heuristic pattern
  match, not a certainty - every check describes the specific observable
  problem (a real placeholder title, a real localhost URL in metadata,
  a real catastrophic robots.txt rule) rather than claiming to detect
  "AI-generated-ness" itself, and false negatives on cleverer
  placeholder text are expected and acceptable (better to under-claim
  than to mislabel a legitimate site).

## Session 6 — Advanced SEO / search-readiness upgrade (secondary agent)

**Phase**: not a numbered Roadmap phase - an UPGRADE of the existing SEO
capability (present since Session 1) toward a much more advanced,
production-ready technical-SEO analyzer, in parallel with other
secondary agents (browser/runtime verification, security, accessibility/
UX) working on separate areas. Explicitly done WITHOUT building or
modifying the multi-page crawler itself (still Roadmap Phase 5, still
not implemented) - this session built the SEO *interpretation* layer
and documented the exact shape the future crawler needs to feed it.

**IMPORTANT - test execution could not be verified this session.** The
sandbox this session ran in had no `node_modules` installed and no
network access to any package registry (`npm install` failed with
`ENOTCACHED` / `403`), so `npm test` and `npm run typecheck` could not
actually be run. Every new/changed file was written and manually
proof-read for type correctness against the existing `types.ts`
contracts, and every test's expected outcome was hand-traced against
the implementation logic, but **this is not a substitute for actually
running the suite.** The very next thing to do in a session that has
working `npm install` is:

```bash
cd server && npm install && npm run typecheck && npm test
```

...and fix whatever that surfaces. Do not assume the code below is
correct just because it's documented as complete - verify first.

### What was implemented

Followed the existing MEASURE -> ANALYZE split used everywhere else in
this project. Nothing here replaced the existing SEO collector/rules
(`collectHtml` in `htmlCollector.ts`, the basic SEO checks in
`analysis/issues.ts`) - those are untouched and still run first; this
session only *added* a deeper layer alongside them.

- **`src/collectors/seoCollector.ts`** (new): `collectSeoExtras()`, a
  second `cheerio.load()` pass (same pattern as
  `accessibilityCollector.ts` in Session 5) producing indexability
  signals (meta robots + X-Robots-Tag parsed into structured
  directives, with `crawlable` vs `indexable` kept distinct), deep
  canonical analysis (resolved-vs-relative, malformed, cross-domain,
  self-referencing, duplicate-declaration count), Open Graph/Twitter
  card facts, hreflang facts, image dimension/generic-filename facts,
  and content-discoverability facts (visible text length, thin-content
  and placeholder-page heuristics).
- **`src/analysis/structuredData.ts`** (new): JSON-LD parsing
  (`<script type="application/ld+json">`, including `@graph`
  flattening), malformed-JSON evidence capture, duplicate-block
  detection, required-property completeness checks for a deliberately
  small set of high-value schema.org types (Organization, WebSite,
  BreadcrumbList, Article/NewsArticle/BlogPosting, Product, Offer,
  LocalBusiness, FAQPage - NOT the full spec, per the task's own
  instruction), and `compareStructuredDataToPage()` - a deterministic,
  evidence-only comparison of schema price/name/headline against the
  page's own visible text (never inferring anything not actually
  observable on the page).
- **`src/collectors/robotsCollector.ts`** (new): `parseRobotsTxt()`
  (User-agent groups, Disallow/Allow, Crawl-delay, Sitemap refs, syntax
  warnings) and `checkRobotsPath()` (longest-matching-rule-wins,
  Allow-beats-Disallow-on-tie, matches the de-facto standard most
  engines follow). `fetchRobotsTxt()` resolves to `available: false`
  on any failure (missing robots.txt is normal, not an error).
- **`src/collectors/sitemapCollector.ts`** (new): `parseSitemapXml()` -
  a deliberately small regex-based extractor (no XML dependency was
  added; this project has none and adding one for this alone seemed
  disproportionate) tolerant of minor malformation but honest about
  genuinely broken input (no `<urlset>`/`<sitemapindex>` root, missing/
  unparseable `<loc>`). `fetchSitemap()` follows one level of
  sitemap-index nesting (bounded by `maxChildSitemaps`) and merges
  child URLs.
- **`src/collectors/resourceFetcher.ts`** (new): a small, scoped
  text/XML fetcher for robots.txt/sitemap.xml specifically - NOT a
  general crawler fetcher. `collectHttp()` intentionally rejects
  non-HTML responses, so this couldn't reuse it directly; instead it
  reuses the exact same SSRF guard (`assertHostAllowed`, now exported
  from `httpCollector.ts` - the only change to that file) and the same
  manual-redirect-revalidation pattern, rather than duplicating or
  weakening the guard.
- **`src/analysis/seoIssues.ts`** (new): `detectAdvancedSeoIssues()` -
  single-page rules for everything `analysis/issues.ts` does NOT
  already cover: conflicting indexability signals, canonical
  malformed/cross-domain/relative/self-reference/duplicate-declaration,
  robots.txt-vs-current-page cross-check, structured-data malformed/
  incomplete/mismatched/duplicate, incomplete Open Graph, og:url-vs-
  canonical mismatch, malformed/missing-self-reference hreflang, images
  missing dimensions, and thin-content/placeholder-page detection.
  Explicitly does NOT re-flag title/description/H1/canonical-presence/
  viewport/alt-text - those stay owned by `analysis/issues.ts` (same
  non-duplication precedent as Session 5's Accessibility-vs-SEO split).
  Own id counter/prefix (`seo-adv-N`), same pattern as
  `accessibilityIssues.ts`'s `accessibility-N`.
- **`src/analysis/siteSeoAnalysis.ts`** (new) - **the crawler
  integration point.** `analyzeSite()` is a pure function (no network
  I/O, no crawl orchestration) over an array of `SitePageInput` (new
  type in `types.ts`: url, statusCode, redirectTarget, `HtmlAnalysis`,
  `SeoExtendedAnalysis`, internalLinks, optional depth) plus a homepage
  URL and optional `SitemapAnalysis`. Computes duplicate titles/
  descriptions, canonical conflicts (target is noindex/redirects/4xx+),
  an internal-link graph (BFS depth from homepage, inbound-link counts,
  orphan detection split into `no-internal-inbound-links` vs
  `sitemap-only`), broken/redirected/noindex-target internal links,
  sitemap-vs-discovered reconciliation, and URL-variant grouping
  (scheme/www/trailing-slash-insensitive). Full doc comment at the top
  of the file spells out exactly what Main Claude's crawler needs to
  hand it. Own id prefix `seo-site-N`.
- **`src/types.ts`** (extended, not modified): every new interface
  (`IndexabilitySignals`, `CanonicalAnalysis`, `OpenGraphAnalysis`,
  `HreflangAnalysis`, `StructuredDataAnalysis` + friends,
  `RobotsTxtAnalysis`, `SitemapAnalysis`, `SitePageInput`,
  `SiteSeoReport` + friends) is additive. `AnalysisReport` gained two
  new fields (`robotsTxt`, `evidenceLog.seo`) - every existing field is
  untouched.
- **`src/pipeline.ts`**: wired `collectSeoExtras()` and
  `detectAdvancedSeoIssues()` into the existing single-page flow
  alongside (not instead of) the existing SEO/HTTP/accessibility/CWV
  issue detection, and added a best-effort `fetchRobotsTxt()` call
  (wrapped the same way `safeAnalyzePerformance` wraps the performance
  provider - a robots.txt failure can never fail the whole scan).

### What was deliberately NOT done (out of scope per the task)

- No second crawler. `analyzeSite()` takes pre-fetched page data; it
  does not fetch anything itself.
- No browser/runtime verification, no full-site security subsystem, no
  accessibility/UX work - those are the other secondary agents' areas.
- No LLM anywhere in this code path - every finding above is produced
  by parsing/comparing actual fetched HTML/HTTP/XML, never generated.
- No attempt at the full Schema.org spec - only the high-value types
  listed above have required-property checks.
- No new top-level report category - advanced SEO findings use
  `category: "seo"`, same as the existing basic SEO rules, specifically
  to avoid double-counting one underlying problem across categories
  (see Section 21 of this session's task prompt).

### New tests (all new; existing test files untouched)

`test/seoCollector.test.ts`, `test/structuredData.test.ts`,
`test/robotsCollector.test.ts`, `test/sitemapCollector.test.ts`,
`test/seoIssues.test.ts`, `test/siteSeoAnalysis.test.ts`,
`test/seoPipeline.test.ts` - unit tests for every new collector/
analysis function plus a pipeline-level integration test (real HTTP
against a small inline Express app, matching `accessibilityPipeline.test.ts`'s
existing pattern) verifying a clean SEO page produces zero new false
positives, a genuinely broken page produces both the existing basic
SEO findings AND the new advanced ones side by side, and robots.txt
blocking flows through end to end. **Exact new test count was not
confirmed by an actual `npm test` run this session - see the warning
above.** `mock-site/app.ts` was intentionally left untouched (new
pipeline/collector-level tests instead build their own small inline
Express apps, exactly the pattern `accessibilityPipeline.test.ts`
already established in Session 5) - lower risk than extending a shared
fixture file other tests also depend on.

### Architectural decisions worth knowing for next session

- **`collectSeoExtras()` is a second collector, not a rewrite of
  `collectHtml()`.** Same reasoning as Session 5's
  `accessibilityCollector.ts`: a second `cheerio.load()` pass is
  cheap, and it means the existing, tested `htmlCollector.ts` and its
  tests needed zero changes.
- **robots.txt/sitemap fetching is intentionally scoped, not a general
  fetcher.** `resourceFetcher.ts` exists only because `collectHttp()`
  rejects non-HTML content-types by design (correct for page content,
  wrong for robots.txt/XML sitemaps). It reuses the SSRF guard rather
  than re-implementing it - `assertHostAllowed` is now exported from
  `httpCollector.ts` (the one, minimal, additive change to that file).
- **No XML parser dependency was added.** `parseSitemapXml()` uses
  scoped regex extraction instead. This is a real, documented
  limitation (not a silent gap): it doesn't validate full XML
  well-formedness beyond root-element and `<loc>` presence. If a future
  session needs stricter XML validation, that's the place to revisit -
  don't add a dependency without checking whether the sandbox's network
  restrictions (see the warning at the top of this section) allow
  `npm install` to actually fetch it first.
- **Site-level analysis is a pure function precisely so it doesn't
  block on the crawler existing.** `analyzeSite()` was tested entirely
  with directly-constructed `SitePageInput[]` fixtures (built from real
  HTML run through the real `collectHtml`/`collectSeoExtras`
  collectors, only the crawl-graph metadata supplied by hand) rather
  than waiting for Phase 5. When the crawler lands, it should NOT need
  changes to this file - only a caller that builds `SitePageInput[]`
  and invokes `analyzeSite()`.

## Session 5 (this session) — Accessibility engine: implementation, integration, and full verification

**Phase**: Roadmap Phase 4 (Accessibility analysis engine) — **DONE**
per this project's own Definition of Done (implemented + integrated +
targeted tests pass + full regression passes + typecheck clean +
README/state docs updated).

**Baseline test count** (confirmed green before any change this
session): 140/140, typecheck clean.
**Final test count**: 197/197, typecheck clean. (57 net new: 26 in
`accessibilityCollector.test.ts`, 23 in `accessibilityIssues.test.ts`,
8 in `accessibilityPipeline.test.ts`.)

### What was implemented

Followed the exact existing architecture pattern (collector -> issues
-> scorer -> pipeline -> frontend), used twice already for Performance/
CWV and Security/SEO — no parallel system was created for Accessibility.

- **`src/collectors/accessibilityCollector.ts`** (new): a second,
  independent `cheerio.load()` pass over the same HTML body
  (`htmlCollector.ts`'s existing signature/tests were preserved
  unchanged rather than refactored to share its `$` instance — see
  Architectural Decisions below for why). Collects, in single linear
  passes per concern (not per-check re-traversal): `lang` attribute,
  full heading outline (h1-h6, document order), image alt-text state
  (three-way: no attribute / empty / non-empty), form control labeling,
  button/link accessible names, duplicate ids, ARIA reference
  integrity, ARIA role validity, viewport zoom restriction, table
  header structure, iframe titles, autoplay media control state,
  non-interactive-but-clickable elements, and positive `tabindex`
  values.
- **`src/analysis/accessibilityIssues.ts`** (new): `detectAccessibilityIssues()`
  turns those facts into the existing `Issue` shape (same fields,
  same `makeIssue`/counter-based-stable-ID pattern as `issues.ts` and
  `cwvIssues.ts`), so they flow through the *existing* `scoreCategory()`
  deduction table — no second scoring system. `buildAccessibilityCoverage()`
  returns the explicit "checked vs. not verifiable by static analysis"
  disclosure (WCAG concerns like color contrast/keyboard traps/focus
  order genuinely cannot be determined from markup alone) — attached to
  every report so a low-issue-count scan is never presented as proof of
  compliance.
- **`src/types.ts`**: `Category` gained `"accessibility"`; added
  `AccessibilityAnalysis`, `AccessibilityCoverage` types;
  `AnalysisReport` gained `scores.accessibility`, `accessibilityCoverage`,
  and `evidenceLog.accessibility`.
- **`src/analysis/scorer.ts`**: `CATEGORIES` array gained
  `"accessibility"` (this is what makes it participate in the overall
  average - not a UI-only addition); `prioritize()`'s category tiebreak
  map gained an entry (a missing entry here would have produced `NaN`
  in tie-break comparisons for accessibility issues - caught during
  implementation, see Architectural Concerns below).
- **`src/pipeline.ts`**: calls `collectAccessibility()` +
  `detectAccessibilityIssues()` alongside the existing HTTP/CWV calls;
  removed `"accessibility"` from the `NOT_YET_ANALYZED` placeholder
  list (it was there since Session 1 as a roadmap placeholder).
- **Frontend** (`client/index.html`, `styles.css`, `app.js`): the
  category grid, filter tabs, and issue list were ALREADY
  category-agnostic (they iterate `report.categoriesAnalyzed`/
  `report.allIssues` generically) - only `CATEGORY_LABELS` needed a new
  entry. The ONE real integration bug found and fixed: `.category-grid`
  had a **hardcoded `grid-template-columns: repeat(3, 1fr)`** that
  would have squeezed a 4th category card awkwardly - changed to
  `repeat(auto-fit, minmax(190px, 1fr))`. Added a new "Accessibility
  scan coverage" panel rendering `accessibilityCoverage` (checked vs.
  not-verifiable, in plain language) between "All findings" and "Raw
  evidence log".

### Deliberate non-duplication decisions (see README "Accessibility
analysis" section for the user-facing version of this)

- Missing/empty `<title>` and missing/multiple `<h1>`: already SEO
  findings with no distinct accessibility angle - not duplicated here,
  matching Lighthouse's own categorization and this project's TTFB
  precedent (CWV Session 2).
- Missing viewport (bare presence): stays SEO-only; Accessibility adds
  a genuinely distinct, more specific check (explicit zoom-disabling)
  that SEO doesn't cover at all.
- Images missing alt: intentionally checked under BOTH SEO and
  Accessibility (legitimate real-world overlap, Lighthouse does the
  same) - but Accessibility uses its OWN stricter "missing" definition
  (alt attribute absent entirely) rather than the SEO layer's broader
  one (which also treats `alt=""` as missing, since that's irrelevant
  to search indexing but is a *valid, correct* decorative marker for
  accessibility purposes). This required a fresh, more precise image
  pass in the new collector rather than reusing `HtmlAnalysis.images.missingAlt`.
- Requested checklist items #6 (inputs without accessible names) and
  #19 (empty links/buttons) were folded into the unified form-control/
  button/link accessible-name checks (#5/#7/#8) rather than creating
  redundant near-identical rules with the same evidence.

### Files changed this session (Session 5)

New:
```
server/src/collectors/accessibilityCollector.ts
server/src/analysis/accessibilityIssues.ts
server/test/accessibilityCollector.test.ts
server/test/accessibilityIssues.test.ts
server/test/accessibilityPipeline.test.ts
PROJECT_STATE.md                              # pointer file - see note at top of this file
```

Modified:
```
server/src/types.ts            # Category += "accessibility"; + AccessibilityAnalysis,
                                #   AccessibilityCoverage; AnalysisReport += scores.accessibility,
                                #   accessibilityCoverage, evidenceLog.accessibility
server/src/analysis/scorer.ts  # CATEGORIES += "accessibility"; prioritize() tiebreak map += accessibility
server/src/pipeline.ts         # calls collectAccessibility()/detectAccessibilityIssues(); removed
                                #   "accessibility" from the NOT_YET_ANALYZED placeholder list
client/index.html              # new #a11y-coverage-panel section
client/styles.css              # .category-grid now auto-fit (was hardcoded to 3 columns - a real
                                #   integration bug this session's work exposed); new .a11y-coverage-* rules
client/app.js                  # CATEGORY_LABELS += accessibility; NOT_YET_LABELS -= accessibility;
                                #   new renderAccessibilityCoverage()
server/test/scorer.test.ts     # updated the one test with a hardcoded "3 categories" average
                                #   assumption (see Architectural Concerns below - unavoidable
                                #   given a real 4th category was added, not a regression)
README.md                      # new Roadmap section, "Accessibility analysis" section, updated
                                #   file tree and test counts throughout
PROJECT_PROGRESS.md            # this entry
```

Unchanged (verified still correct, not touched this session):
`src/collectors/httpCollector.ts`, `src/collectors/htmlCollector.ts`, `src/analysis/issues.ts`,
`src/analysis/cwvIssues.ts`, `src/analysis/performanceThresholds.ts`, `src/providers/*`,
`src/cache/*`, `src/net/retry.ts`, `src/middleware/rateLimit.ts`, `src/logging/logger.ts`,
`src/routes/analyze.ts`, `src/app.ts`, `src/server.ts`, `mock-site/*`, every pre-existing test file.

## Completed

**Session 4 (this session) — SSRF/DNS security gap-closing + verification:**

The previous session's SSRF work was reviewed against a 17-item checklist
and found to have **one genuine, exploitable gap** plus several
under-tested-but-correct areas. Both are now fixed/covered:

- **Fixed a real bypass**: the IPv4-mapped/compatible IPv6 detection used
  a regex that only matched the dotted-decimal form
  (`^::ffff:\d+\.\d+\.\d+\.\d+$`). Empirically verified that Node's URL
  parser (per the WHATWG URL Standard) ALWAYS canonicalizes these into
  pure hex groups instead - e.g. `[::ffff:127.0.0.1]` becomes hostname
  `[::ffff:7f00:1]` - so the old regex **never actually matched what the
  code received**, meaning any IPv4-mapped-IPv6 loopback/private/metadata
  address (e.g. `http://[::ffff:169.254.169.254]/`) silently bypassed the
  guard entirely. Replaced with `expandIPv6Groups()`, a proper `::`-aware
  16-bit-group parser, and rewrote all IPv6 range checks
  (loopback/unspecified/link-local/ULA/mapped/compatible) to operate on
  the parsed groups instead of string patterns - representation-independent
  by construction. Also added NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`)
  embedded-IPv4 detection after confirming empirically that Node's parser
  accepts and canonicalizes both forms.
- **Closed a real test-rigor gap**: the previous session's "redirect to a
  blocked target" test called the SSRF helper directly rather than
  exercising `collectHttp`'s actual redirect loop (explicitly flagged as
  a limitation in that session's own progress notes). Added a new
  `testBypassHosts` option to `CollectHttpOptions` - a narrow, test-only
  escape hatch (never read from an env var, never passed by any
  production call site) that exempts a specific hostname from the guard
  for one call, so a test can let hop 1 (a real local Express server)
  through while the redirect target (hop 2) is judged by the real,
  unmodified guard via an injected DNS resolver. The new test proves the
  initial hop was genuinely fetched over real HTTP (`hop1WasHit`
  assertion) before the redirect to the private-resolving hostname was
  rejected.
- **Verified (not assumed) that Node's URL parser normalizes every
  common IPv4 obfuscation technique** (hex `0x7f000001`, octal
  `0177.0.0.1`, decimal `2130706433`, short form `127.1`,
  per-octet-mixed forms, even fullwidth Unicode digits) into plain
  dotted-decimal before the guard ever sees it - confirmed empirically
  with a standalone Node script, then locked in with tests so a future
  Node upgrade that changed this behavior would be caught.
- **Added explicit test coverage** for every one of the 17 requested
  checklist items, including several that were already correctly
  handled by the existing code but untested: multiple DNS answers where
  only one is private, a hostname that merely *contains* a
  private-IP-looking label (judged by real DNS resolution, not string
  matching), redirects to non-`http(s)` schemes (`ftp:`, `javascript:`),
  exactly-at-the-limit vs. over-the-limit redirect counts, and multiple
  *legitimate* redirect hops succeeding end-to-end.
- Exported the internal IP-checking functions (`isPrivateIPv4`,
  `isPrivateIPv6`, `isPrivateIp`, `expandIPv6Groups`, `ipToInt`) from
  `httpCollector.ts` so range logic can be unit-tested directly and
  exhaustively, in addition to the slower, real-network end-to-end tests.
- **`CollectorError` taxonomy is unchanged** - no codes added, removed,
  or renamed. Only the internal detection logic changed.

**Sessions 1-3** (MVP, PageSpeed/Core Web Vitals, production hardening)
unchanged - not repeated here.


**Session 1 (MVP vertical slice)** and **Session 2 (real Core Web
Vitals via PageSpeed Insights)** — both unchanged, still fully working.
Not repeated here; see git history / earlier notes for detail.

**Session 3 (this session) — Production hardening:**

- **PageSpeed caching** (`src/cache/cache.ts`, `src/cache/urlNormalize.ts`,
  `src/providers/cachingPerformanceProvider.ts`): a small `Cache<T>`
  interface (`get`/`set`/`delete`) with one implementation,
  `InMemoryCache` (lazy expiry on read + a light periodic sweep,
  unref'd so it never keeps a process/test alive). `CachingPerformanceProvider`
  is a decorator around any `PerformanceProvider` that adds caching
  without changing `PageSpeedProvider` at all - keyed by
  `normalizeCacheKey(url, strategy)` (scheme/host lowercased, trailing
  slash + default port stripped, query params sorted, fragment
  dropped). TTL configurable via `PAGESPEED_CACHE_TTL` (default 300s).
  **Only successful (`status: "available"`) results are cached** -
  failures are never cached, so a transient PageSpeed outage self-heals
  on the very next scan instead of being stuck for the whole TTL.
- **Concurrent request protection**: the same `CachingPerformanceProvider`
  tracks in-flight calls in a `Map<key, Promise>`; two scans of the
  same normalized URL that arrive while a PageSpeed call is already
  running share that one call instead of firing a second one. Verified
  under real concurrency with `Promise.all(...)` in tests.
- **Rate limiting** (`src/middleware/rateLimit.ts`): a simple in-memory
  fixed-window limiter on `POST /api/analyze`, keyed by client IP
  (`req.ip`, with `app.set("trust proxy", true)` so this respects
  `X-Forwarded-For` behind a real load balancer). Configurable via
  `ANALYZE_RATE_LIMIT` / `ANALYZE_RATE_WINDOW`. Returns `429` with a
  `Retry-After` header and a `retryAfterSeconds` field. `createApp()`
  accepts a `rateLimiter` option (custom config or `false` to disable)
  specifically so the automated test suite is never flaky against the
  shared default limit - every test file that isn't testing rate
  limiting itself explicitly passes `rateLimiter: false`.
- **Timeouts**: both external calls (target-site fetch, PageSpeed
  request) already had explicit `AbortController` timeouts from
  earlier sessions; this session made both configurable via env vars
  (`TARGET_FETCH_TIMEOUT`, `PAGESPEED_TIMEOUT`) instead of hardcoded
  constants.
- **Retry policy** (`src/net/retry.ts` + `PageSpeedProvider`): a small
  generic `withRetry()` helper (bounded attempts, exponential backoff,
  injectable sleep for deterministic tests). Wired into `PageSpeedProvider`
  only, retrying network-level errors and 5xx responses
  (`MAX_RETRIES`, default 2) - never 429, never other 4xx, never a
  malformed response, never a timeout (see Architecture Decisions for
  why timeouts specifically aren't retried). Target-website fetches are
  deliberately **not** retried this session (see Known Limitations).
- **Error model** (`src/collectors/httpCollector.ts`): `CollectorError`
  codes renamed/extended to a specific taxonomy - `INVALID_URL`,
  `BLOCKED_HOST`, `DNS_ERROR`, `TARGET_TIMEOUT`, `TARGET_UNREACHABLE`,
  `NON_HTML` - mapped to appropriate HTTP statuses in
  `routes/analyze.ts`. PageSpeed-side failures deliberately keep using
  the existing `ProviderStatus` enum rather than a second parallel
  error-code system (see Architecture Decisions).
- **Scan status**: `AnalysisReport.status` is `"success"` (target +
  PageSpeed both completed) or `"partial"` (target completed,
  PageSpeed didn't - Performance/SEO/Security are entirely
  unaffected). `"failed"` is reserved in the type for a future
  batch/crawl mode; today an unreachable target throws before any
  report is built, which `routes/analyze.ts` turns into an HTTP error
  response instead.
- **Observability** (`src/logging/logger.ts`): minimal structured
  single-line-JSON logging (no dependency) for `scan_started`,
  `scan_completed`, `scan_failed`, `cache_hit`, `cache_miss`,
  `pagespeed_request`, `pagespeed_failure`, `rate_limit_rejected`.
  Field names matching `key`/`token`/`secret`/`password`/`authorization`/
  `cookie` are redacted automatically, so a future call site can't
  accidentally log a secret.
- **Security hardening** (`src/collectors/httpCollector.ts`): the
  Session-1 SSRF guard was hostname-string-only and used
  `redirect: "follow"`, which is a known SSRF bypass (a redirect to an
  internal address would have been silently followed). Rewritten to:
  (1) a **DNS-rebinding guard** that resolves the hostname and checks
  the actual IP(s) against RFC1918/loopback/link-local/CGNAT/multicast
  ranges for both IPv4 and IPv6 (catches e.g. a public-looking hostname
  that resolves to the cloud metadata endpoint `169.254.169.254`), and
  (2) **manual redirect following** (`redirect: "manual"` + a capped
  5-hop loop) that re-runs the exact same guard on every redirect
  target, not just the initial URL. `ALLOW_LOCAL_TARGETS=true` still
  bypasses everything for local dev/tests only. Also added: a real
  `redirectCount` (previously always 0 or 1 due to `fetch()`'s
  automatic-redirect limitation - now accurate since redirects are
  followed manually), a request-body-size error handler so oversized
  or malformed JSON returns a clean `413`/`400` instead of crashing.
- **Config**: `.env.example` documents every new variable with
  defaults (`PAGESPEED_CACHE_TTL`, `PAGESPEED_TIMEOUT`, `MAX_RETRIES`,
  `TARGET_FETCH_TIMEOUT`, `ANALYZE_RATE_LIMIT`, `ANALYZE_RATE_WINDOW`).
  `PAGESPEED_API_KEY` is accepted as an alias for the existing
  `PAGESPEED_INSIGHTS_API_KEY` (kept as primary to avoid a breaking
  rename for anyone who already set the Session-2 name).
- **Docs**: `README.md` has a full new "Production hardening" section
  (caching, concurrency protection, rate limiting, timeouts, retries,
  scan status, error model, security/SSRF) plus a "Development mock
  target site" section explaining why the mock site exists and isn't a
  throwaway.

## Currently Working

Nothing in-flight. This session's scope (caching, rate limiting,
concurrency protection, timeouts, retries, error model, scan status,
observability, SSRF hardening, tests, docs) is complete and verified,
both by the automated suite and by live manual runs of the real server
(see "Manual verification performed this session" below).

## Next Task

**Roadmap Phase 5 — multi-page crawler** (see `README.md` Roadmap).

Concretely, this means extending the pipeline from "analyze one URL"
to "discover and analyze multiple pages of a site." Suggested starting
point for the next session:
1. Inspect `src/pipeline.ts` and `src/collectors/httpCollector.ts`
   first - the crawler should reuse `collectHttp`/`collectHtml` per
   page, not duplicate their logic.
2. Add a sitemap.xml/robots.txt-aware URL discovery step, with a hard
   cap on page count and crawl depth (config via env var, e.g.
   `MAX_CRAWL_PAGES`), and respect the same SSRF guard per discovered
   URL (every discovered link is itself untrusted input).
3. Reuse the existing rate limiter / caching / retry infrastructure
   (Session 3) rather than inventing crawl-specific versions - a crawl
   is just many `analyzeUrl()` calls, ideally with bounded concurrency
   (a small worker-pool pattern, not one Promise.all of everything) and
   the SAME PageSpeed caching (so if two crawled pages or two separate
   crawls hit the same page, PageSpeed still isn't called twice within
   the TTL).
4. New aggregate report shape (site-level score/issues rollup across
   pages) - design this fresh rather than bolting onto
   `AnalysisReport`, then decide whether `AnalysisReport` becomes "one
   page's result" nested inside a new `SiteCrawlReport`.
5. Tests first for URL discovery and crawl-depth/page-count limits
   before wiring up scoring rollup.

Do not start this in the same session as a redesign of the existing
single-page dashboard - the crawler is additive (a new mode/endpoint),
not a replacement for `POST /api/analyze`.

**Do NOT start the pre-launch verification/approval reframing
(`APPROVED FOR LIVE`/`DO NOT LAUNCH`/etc., PASS/FAIL/NOT VERIFIED/
ERROR/NOT APPLICABLE per-check states, launch-blocker-vs-improvement
split, confidence-as-a-separate-dimension-from-severity) until the
crawler exists.** That reframing fundamentally needs multi-page
coverage to make an honest site-wide launch decision - a single-page
scan cannot itself say "this site is safe to launch." It's recorded in
`README.md`'s Roadmap so it isn't lost, not because it's next.

## Files Changed — Session 3 (production hardening)

New this session:

```
server/src/cache/cache.ts
server/src/cache/urlNormalize.ts
server/src/net/retry.ts
server/src/logging/logger.ts
server/src/middleware/rateLimit.ts
server/src/providers/cachingPerformanceProvider.ts
server/test/cache.test.ts
server/test/urlNormalize.test.ts
server/test/retry.test.ts
server/test/cachingPerformanceProvider.test.ts
server/test/rateLimit.test.ts
server/test/pageSpeedProviderRetry.test.ts
server/test/httpCollectorSecurity.test.ts
server/test/scanStatus.test.ts
server/test/appHardening.test.ts
```

Modified this session:

```
server/src/types.ts                        # + ScanStatus, PerformanceProviderResult.cache,
                                             #   CoreWebVitalsReport.cached/cacheAgeMs, AnalysisReport.reportId/status
server/src/collectors/httpCollector.ts      # SSRF hardening (DNS-rebinding guard, manual redirect
                                             #   re-validation), new CollectorErrorCode taxonomy,
                                             #   configurable timeout, accurate redirectCount
server/src/providers/pageSpeedProvider.ts   # retry policy for transient failures, configurable
                                             #   timeout/retries via env, PAGESPEED_API_KEY alias, logging
server/src/pipeline.ts                      # wires the caching provider by default, computes scan
                                             #   status, generates reportId, scan-level logging
server/src/routes/analyze.ts                # updated error-code -> HTTP-status mapping
server/src/app.ts                           # rate limiter wiring (configurable/disableable),
                                             #   body-parser error handling, trust proxy
server/.env.example                         # all new config vars documented with defaults
README.md                                   # new "Production hardening" + "Development mock target
                                             #   site" sections, updated file tree, updated test count
test/integration.test.ts                    # app now constructed with rateLimiter: false
```

Unchanged (verified still correct, not touched): `src/collectors/htmlCollector.ts`,
`src/analysis/issues.ts`, `src/analysis/cwvIssues.ts`, `src/analysis/scorer.ts`,
`src/analysis/performanceThresholds.ts`, `src/providers/performanceProvider.ts`,
`src/server.ts`, `mock-site/*`, `client/*`, all Session 1 & 2 test files
(`htmlCollector.test.ts`, `scorer.test.ts`, `issues.test.ts`,
`pageSpeedProvider.test.ts`, `cwvIssues.test.ts`, `pipelineCwv.test.ts`).

## Tests — Session 3 detail (still accurate for those files)

Run with `cd server && npm run typecheck && npm test`.

**Last run: 122/122 passing, typecheck clean.**

**Session 4 update: 140/140 passing, typecheck clean** (122 carried
over unchanged + 18 net new in `httpCollectorSecurity.test.ts`, which
grew from 12 to 30 tests covering all 17 checklist items). See
"Completed" above for what changed.

**Session 5 update: 197/197 passing, typecheck clean** (140 carried
over unchanged + 57 net new for Accessibility - see the Session 5
section at the top of this file for the full breakdown by test file).

- 56 tests carried over from Sessions 1-2, unchanged and still passing
  (regression-free) — includes re-verifying in isolation that
  `integration.test.ts`'s app (now built with `rateLimiter: false`)
  still exercises the full pipeline correctly.
- `test/cache.test.ts` (6) — set/get, missing-key, TTL expiration
  (via injectable clock), delete, key independence, cachedAt/expiresAt
  correctness.
- `test/urlNormalize.test.ts` (11) — same-URL/trailing-slash/case/
  query-order/default-port/fragment all produce the *same* key;
  different path/host/query/strategy/non-default-port all produce
  *different* keys.
- `test/cachingPerformanceProvider.test.ts` (8) — cache miss calls +
  caches; cache hit skips the inner call; TTL expiration triggers a
  fresh call; a failed result is never cached (verified by observing
  the inner provider is called again immediately after a failure);
  normalized-URL-variant reuse; independent keys for different URLs;
  concurrent identical requests coalesce into one inner call
  (via `Promise.all`); concurrent *different* URLs do NOT coalesce.
- `test/retry.test.ts` (6) — succeeds first try with no retry; retries
  a transient failure until success; exhausts `maxRetries` and throws
  the last error; does not retry when `shouldRetry` says no;
  `maxRetries: 0` means exactly one attempt; backoff delay grows
  exponentially (`100, 200, 400` for base 100).
- `test/pageSpeedProviderRetry.test.ts` (8) — a transient 503 retried
  and succeeds; a persistent 502 exhausts retries and returns `error`;
  a network-level throw is retried; 429 is never retried (single call
  only); 404 is never retried; a malformed response body is never
  retried; a timeout is never retried; `maxRetries: 0` fails
  immediately on a single 503.
- `test/rateLimit.test.ts` (5) — under-threshold requests allowed;
  over-threshold returns 429 + `Retry-After`; the limit resets once the
  window elapses (injectable clock, no real waiting); different keys
  (e.g. different IPs) are tracked independently; `X-RateLimit-Remaining`
  counts down correctly.
- `test/httpCollectorSecurity.test.ts` (10) — unsupported protocol and
  malformed URL rejected; `localhost`, bare loopback IPv4, the cloud
  metadata link-local address, RFC1918 ranges, and the IPv6 loopback
  literal are all rejected; a DNS-rebinding case (public-looking
  hostname resolving to a private IP via an injected fake DNS lookup)
  is rejected; a DNS resolution failure produces `DNS_ERROR` cleanly;
  a redirect target is re-validated by the identical guard function
  used for the initial request; `ALLOW_LOCAL_TARGETS=true` bypasses
  the guard end-to-end across a real redirect (dev-mode regression
  coverage); more than 5 redirects is rejected as `TARGET_UNREACHABLE`
  instead of looping forever.
- `test/scanStatus.test.ts` (6) — `status: "success"` when both HTTP
  and PageSpeed complete; `status: "partial"` for rate-limited/timeout/
  not-configured PageSpeed outcomes (three separate cases); a
  completely unreachable target throws before any report exists (the
  FAILED case, at the pipeline layer); every report has a unique
  `reportId`.
- `test/appHardening.test.ts` (4) — `POST /api/analyze` rate limiting
  end-to-end through the real Express app (429 + `Retry-After` +
  `retryAfterSeconds` body field); `rateLimiter: false` disables it
  entirely; an oversized body returns a clean 413 (and the server
  stays alive afterward, verified via a follow-up health check);
  malformed JSON returns a clean 4xx (same aliveness check).

**Manual verification performed this session** (see session transcript
for full command output):
1. `npm run typecheck && npm test` — 122/122 passing, confirmed before
   AND after all changes (baseline check at session start, final check
   at session end).
2. Started the real server + mock site together and ran a normal scan
   against `/clean` — got a complete report with `status: "partial"`
   (no real PageSpeed key available in this sandbox) and correct
   scores.
3. Verified the **cache-hit path** against the real pipeline code
   (not just unit tests) using a throwaway script that injects a
   fake-but-realistic "always succeeds" performance provider wrapped in
   the real `CachingPerformanceProvider`: first scan showed
   `cached: false` and one inner provider call; second scan of the
   same URL showed `cached: true`, a populated `cacheAgeMs`, and
   confirmed the inner provider's call count stayed at exactly 1
   across both scans.
4. Verified PageSpeed failure produces a **partial**, not failed,
   report: ran the real server with a fake API key against the real
   `googleapis.com` (reachable from this sandbox); Google rejected the
   invalid key, the provider resolved to `status: "error"`, and the
   scan still returned `status: "partial"` with fully-populated
   Performance/SEO/Security scores. Also confirmed the failure was
   correctly NOT cached (a second identical request also showed
   `cached: false` and made a fresh PageSpeed attempt, exactly as
   designed).
5. Verified **rate limiting** end-to-end with a live server configured
   to `ANALYZE_RATE_LIMIT=2`: requests 1-2 returned 200, request 3
   returned 429 with a `Retry-After` header and `retryAfterSeconds` in
   the body.
6. Verified the **mock target site** still works standalone
   (`/clean` and `/messy` both return 200 directly).
7. Verified the **SSRF guard is active by default** (no
   `ALLOW_LOCAL_TARGETS`) against a live server: `127.0.0.1`,
   `169.254.169.254` (cloud metadata), and `localhost` were all
   rejected with `BLOCKED_HOST` before any request left the server.

## Known Limitations

**Session 5 (Accessibility) additions:**
- **A second `cheerio.load()` pass per scan.** `accessibilityCollector.ts`
  re-parses the same HTML body that `htmlCollector.ts` already parsed,
  rather than sharing one cheerio instance - deliberate, to avoid
  changing `collectHtml()`'s existing signature/tests (see
  Architectural Decisions). Bounded cost (body capped at 5MB), not a
  correctness issue, but worth revisiting if a future session finds
  parse time is actually significant at real-world page sizes.
- **The invalid-ARIA-role check only catches unrecognized role
  strings** (typos/nonexistent roles), never whether a *valid* role is
  semantically appropriate for its element - deliberately conservative,
  since that judgment is exactly the kind of thing static analysis
  cannot reliably make (see `accessibilityCoverage.notVerifiable`).
- **The table-header-structure check is a heuristic** (multiple rows
  AND multiple columns AND zero `<th>` anywhere), not a rigorous
  data-table-vs-layout-table classifier - static analysis can't
  reliably tell those apart otherwise. Documented in code and in the
  README.
- **The clickable-non-interactive-element check only looks for an
  inline `onclick` attribute**, not JS-attached event listeners
  (`addEventListener`) - this scanner doesn't execute JavaScript at
  all (see `accessibilityCoverage.notVerifiable`), so listeners
  attached via script are invisible to it by design, not by oversight.
- **No color contrast, keyboard trap, or focus-order checking** -
  explicitly and permanently out of reach for static HTML analysis
  without rendering/executing the page; disclosed on every report via
  `accessibilityCoverage.notVerifiable` rather than silently omitted.

Carried over from Sessions 1-2 (still true):
- No auth, no persistence/history of past scans yet - every scan is
  still stateless beyond the PageSpeed result cache.
- Security header checks (from Session 1) are presence-only, not
  value-strength-aware (e.g. `default-src *` still counts as "has a
  CSP").
- INP lab-data extraction and the desktop-strategy option remain
  unverified against a real live API response with a real API key (no
  key was available in this sandbox in any session so far).

From Session 3, one item is now resolved:
- ~~IPv4-mapped/compatible IPv6 addresses only matched in dotted-decimal
  form~~ - **fixed in Session 4** (see Completed above). This was
  actually a real bypass, not just a test gap - confirmed by testing
  what `url.hostname` produces for `[::ffff:127.0.0.1]` before fixing it.

Still true from Session 3:
- **DNS-rebinding protection has an inherent TOCTOU gap.** The guard
  resolves DNS and checks the IP *before* connecting, but `fetch()`
  itself re-resolves DNS independently when it actually connects - an
  attacker with control over DNS TTLs could theoretically change the
  answer between our check and the real connection. Fully closing this
  requires pinning the connection to the specific IP we validated
  (a custom `Agent`/dispatcher), which remains deliberately not built
  per the "don't over-engineer" instruction - the current guard (hostname
  pattern + bare-IP-literal check covering every representation Node's
  URL parser normalizes + DNS-resolved IP range check, re-applied on
  every redirect hop) blocks every realistic case tested this session
  (metadata endpoints, internal service names, redirect-based SSRF,
  IP obfuscation, IPv4-mapped/NAT64/6to4 IPv6 tunneling forms). Worth
  revisiting only if this app ever handles genuinely adversarial traffic
  at scale.
- **Target-website fetches are not retried**, only PageSpeed calls
  are. This was a deliberate scope decision: automatically retrying
  requests to arbitrary third-party websites has different tradeoffs
  (amplifying load on a site we don't own/control) than retrying calls
  to our own metered PageSpeed quota, and the task's retry requirements
  read most naturally as being about the expensive/quota-limited
  external call. If a future session wants target-fetch retries too,
  `src/net/retry.ts` is already generic and reusable for that.
- **Rate limiting is per-process, in-memory, IP-keyed.** It resets if
  the process restarts, and does not coordinate across multiple server
  instances behind a load balancer (each instance would enforce its
  own independent limit). Fine for the stated "three users" scale; the
  middleware signature (`(req, res, next)`) is unchanged if this is
  later swapped for a Redis-backed limiter.
- **The in-memory PageSpeed cache is also per-process** and has no
  size cap beyond the periodic expired-entry sweep - under real
  traffic with many distinct URLs, this could grow unbounded between
  sweeps. A max-entries eviction policy (e.g. simple LRU) would be a
  reasonable follow-up if memory pressure becomes a real concern; not
  built this session to avoid over-engineering an MVP cache.
- **No live PageSpeed success has been verified in this sandbox** (no
  real API key available) - carried over from Session 2. The cache-hit
  path was verified against the real pipeline with a realistic fake
  provider standing in for a genuine "available" PageSpeed result (see
  Manual Verification item 3), which exercises the exact same code
  path a real success would, just without a live Google response.

## Architecture Decisions

**Session 5 (Accessibility) additions and architectural concerns
discovered while integrating:**
- **A second `cheerio.load()` pass, not a shared `$` instance.**
  `htmlCollector.collectHtml(bodyText, httpsUsed)`'s signature is
  depended on directly by existing tests and `pipeline.ts`; changing it
  to accept/return a cheerio instance so accessibility could reuse the
  same parse would have been a breaking change to completed, tested
  work for a performance micro-optimization with no functional
  benefit at this document-size scale (body capped at 5MB). Chose
  "preserve existing signatures" over "share one parse," consistent
  with this session's explicit instruction not to redesign completed
  work absent a genuine defect.
- **Real integration bug found, not just a missing-feature gap: the
  category grid's CSS was hardcoded to exactly 3 columns**
  (`grid-template-columns: repeat(3, 1fr)`). This wasn't caught by any
  test (the test suite has no visual/layout assertions - a legitimate
  gap in this project's testing approach, since it's server-focused).
  Found by reading the actual CSS before wiring up a 4th category
  rather than assuming the "category-agnostic" JS rendering logic
  meant the whole rendering pipeline was category-count-agnostic. Fixed
  to `repeat(auto-fit, minmax(190px, 1fr))`.
- **One existing test's hardcoded assumption became factually
  incomplete, not wrong: `scorer.test.ts`'s "overall score is the
  average of the three category scores" test literally cannot pass
  unchanged once a real 4th scored category exists** - the divisor in
  the average necessarily changes from 3 to 4. This is different from
  a regression: the test's premise (exactly 3 categories participate in
  scoring) was true when written and is now false by design, not by
  accident. Updated the one test, documented why in the test file
  itself, left everything else in it (the deduction math, the
  per-category score assertions) unchanged.
- **A silent correctness bug was possible and was caught before it
  shipped: `prioritize()`'s `categoryTiebreak` map is a `Record<Category, number>`
  indexed by every category** - TypeScript's structural typing does
  NOT enforce that every key of a union type has an entry unless the
  Record's value type disallows `undefined`, so adding `"accessibility"`
  to `Category` without also adding it to this map would have compiled
  cleanly but produced `NaN` in tie-break sort comparisons for every
  accessibility issue at runtime. Added the entry immediately; worth
  a lint rule or exhaustiveness check in a future session for any
  further category additions (Content/UX/Business/etc. in later
  phases) so this class of bug can't recur silently.
- **Deliberate, reasoned non-duplication decisions** (title/H1/bare
  viewport stay SEO-only; alt-text is intentionally dual-category with
  a stricter accessibility-specific definition) - see the "Deliberate
  non-duplication decisions" note in the Session 5 summary at the top
  of this file, and the README's "Accessibility analysis" section for
  the user-facing explanation. This required genuine engineering
  judgment (not just following a checklist literally), grounded in
  real-world precedent (Lighthouse's own categorization) and this
  project's own established precedent (Core Web Vitals TTFB).

Carried over from Sessions 1-2, still in force (not repeated in full
here - deterministic-measurement/AI-separation, simple fixed-deduction
scoring, static-HTML-only SEO analysis, no-build-step frontend,
CWV-findings-are-Issues-not-a-parallel-scorer, TTFB-not-double-scored,
Lighthouse-score-is-informational-only, provider-errors-are-user-safe-
by-construction).

New in Session 3:
- **Caching and concurrency protection live in ONE decorator
  (`CachingPerformanceProvider`), not two.** The task listed them as
  separate numbered requirements, but they're two facets of the same
  underlying problem (don't call PageSpeed more than necessary for the
  same URL) and share the same cache-key/lookup logic - splitting them
  into separate wrapper classes would have meant either duplicating
  the key-normalization logic or awkwardly chaining two decorators
  that both need to agree on the same key. One class, two
  responsibilities, was judged simpler and easier to reason about
  than the "more modular-looking" two-class version, in keeping with
  the explicit "do not over-engineer" instruction.
- **PageSpeed-side errors keep using the existing `ProviderStatus`
  enum instead of gaining a second, PageSpeed-specific error-code
  system.** The task's suggested taxonomy included
  `PAGESPEED_TIMEOUT`/`PAGESPEED_RATE_LIMITED`/`PAGESPEED_UNAVAILABLE`,
  but `ProviderStatus` (`timeout`/`rate_limited`/`error`/
  `not_configured`/`unavailable`/`available`) already covers exactly
  this distinction and was established in Session 2. Introducing a
  parallel enum that means almost the same thing would be exactly the
  kind of redundant complexity the "quality bar" instruction warned
  against. `CollectorErrorCode` (the *new* taxonomy added this
  session) is scoped only to the target-website-fetch layer, where no
  equivalent taxonomy existed yet.
- **`PAGESPEED_API_KEY` is an alias, not a replacement, for
  `PAGESPEED_INSIGHTS_API_KEY`.** This session's instructions specified
  the former name; Session 2 had already established and documented
  the latter. Renaming outright would silently break anyone who
  already configured Session 2's variable name. `PageSpeedProvider`
  checks `PAGESPEED_INSIGHTS_API_KEY` first, then falls back to
  `PAGESPEED_API_KEY` - both are documented in `.env.example`.
- **Manual redirect-following replaced `fetch`'s built-in
  `redirect: "follow"`.** This was necessary, not optional, once the
  SSRF guard needed to apply per-hop - `redirect: "follow"` gives the
  caller no opportunity to inspect/reject an intermediate redirect
  target before it's followed. This also fixed the pre-existing
  `redirectCount` accuracy limitation as a side effect (now tracks the
  real hop count instead of a 0-or-1 flag).
- **Timeouts are not retried, network errors and 5xx are.** A timeout
  already means "this used its entire allotted time and got nothing" -
  retrying multiplies an already-bad wait by `(maxRetries + 1)` for a
  synchronous, user-facing request. Network errors and 5xx typically
  fail fast, so a bounded retry is a much better time/reliability
  tradeoff for those specifically.

## Continuation Prompt

Read PROJECT_PROGRESS.md first (this file is this project's PROJECT_STATE.md - see the pointer file by that name in the repo root). Do not restart or redesign completed work. Continue from the exact current state. Inspect the existing implementation before making changes.

**FIRST, before anything else**: `cd server && npm install && npm run typecheck && npm test`. Sessions 6-9 added a substantial amount of new SEO and Performance code and matching tests (408 tests total now expected) but could NOT actually run them in any of the four sessions' sandboxes (no `node_modules`, no network access - all four mitigated with vendored/stubbed types for a partial `tsc --noEmit` pass only, documented above). Confirm the real test count and fix any real failures before building on top of this.

Next task: Roadmap Phase 5, the multi-page crawler, following the concrete starting points listed under "Next Task" above - reuse `collectHttp`/`collectHtml`/`collectAccessibility`/`collectSeoExtras`/`collectResourceIntelligence` per page (note: `collectSeoExtras()`'s `seo.links.internal` already extracts same-site links per page - the crawler can reuse that directly as `SitePageInput.internalLinks` instead of re-parsing), reuse the existing rate limiter/caching/retry infrastructure rather than duplicating it, cap page count and crawl depth via env-configurable limits, apply the existing SSRF guard to every discovered URL (not just the seed URL), and design a fresh site-level aggregate report shape rather than overloading the existing single-page `AnalysisReport`. Session 6 added `analysis/siteSeoAnalysis.ts`'s `analyzeSite()` as the documented SEO-side integration point for that crawler - see its file-top doc comment for the exact `SitePageInput[]` shape it expects; the crawler should build that array and call `analyzeSite()` rather than reimplementing any of its logic. Once real multi-page data exists: `analysis/seoVerification.ts`'s `duplicate_metadata` and `internal_link_graph` checks should stop being hardcoded `unverified` and should reflect whatever `analyzeSite()` actually found; and Session 8's `resourceIntelligence` per page is ready to feed a future `siteResourcePerformance.ts` (average/median page weight across N pages, slowest pages, cross-page repeated-resource detection) the same way `analyzeSite()` aggregates SEO facts - that file does not exist yet, don't assume it does. Do NOT start the pre-launch verification/approval reframing (APPROVED FOR LIVE / DO NOT LAUNCH / etc.) until the crawler exists - it's recorded in README.md's Roadmap for later, not now.


## Post-merge integration — completed agent snapshots

Integrated the supplied completed Session 8, Session 10 accessibility, Session 10 SEO, and Session 12 security snapshots into this final baseline. The merge was selective: the final baseline's newer crawler/browser/performance/security infrastructure was preserved, while genuinely missing accessibility/SEO/test work was added. Session 12's real `securityIssues.ts` syntax fix was already present in this baseline and therefore required no code overlay. Playwright is now declared in `server/package.json` because the existing browser collector imports it. Full runtime verification remains a user-environment gate.


## Responsive + UX integration merge — 2026-08-22

Merged from the supplied `a2z-web-insight (6)(1).zip` into the current final-merged-fixed baseline without overwriting the newer performance/security/browser work already present in the baseline.

Integrated:
- UX collection + issue analysis into the single-page pipeline.
- UX as a scored/report category.
- Mobile/desktop responsiveness collector using static HTML/CSS evidence and bounded SSRF-guarded stylesheet inspection.
- Responsiveness issue analysis and mobile/desktop verification summary.
- Responsiveness as a scored/report category.
- Launch-decision category coverage for UX and responsiveness.
- Regression tests for responsiveness collector, issues, and pipeline behavior.
- Supporting report/type/fixture updates.

Evidence boundary retained: responsiveness is static HTML/CSS analysis. It does not claim rendered mobile/desktop layout, touch hitboxes, or desktop Lighthouse metrics without a real renderer.
