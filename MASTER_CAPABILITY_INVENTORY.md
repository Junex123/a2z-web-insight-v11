# MASTER CAPABILITY INVENTORY - V8

This is a capability-preservation record, not a replacement README. V8 is based on the complete V5 baseline and selectively adds verified V7 improvements.

## Preserved baseline capabilities
- HTTP/HTML collection and fetch-quality analysis
- SEO collection, verification, advanced SEO findings, sitemap/robots analysis
- Security collector and security issue analysis, including header-value quality checks
- Accessibility collector/issues/coverage
- UX collector/issues
- Responsive collector/issues/thresholds
- Browser manager + browser collector + Playwright runtime evidence
- Desktop/mobile PageSpeed strategy and responsive/browser analysis
- Runtime findings and browser verification
- Resource probing and resource issue analysis
- Performance opportunities, root-cause chains and verification
- Site crawler, site-wide analysis and site-wide findings
- Evidence inventory/grouping
- Cross-category correlation
- Launch readiness and launch decision
- Existing client/report integration and test suite

## Verified V7 additions promoted into V8
- LCP-image double-count prevention in resource issue grouping, wired from actual PageSpeed LCP evidence into the existing probe-based resource analyzer.
- Security header quality regression tests from V7, against the already-present V5 security implementation.

## Explicitly not promoted
- V7 pipeline/types/package versions wholesale, because that branch removed browser, UX, responsive, runtime, fetch-quality and security collector capabilities present in the V5 baseline.
- V7 resourceIssues replacement, because it would replace the existing probe-based analyzer; its useful non-duplicating improvement was integrated above instead.

## Rule
Future agents must treat this V8 as the master baseline. Agent ZIPs are upgrade proposals only. Never replace the baseline with an agent ZIP wholesale.


## V9 incremental additions
- Launch-readiness status/banner is now visible in the frontend.
- Category readiness is visible beside category scores.
- Verification coverage/disclosure is visible.
- Cross-category root-cause correlations are visible.
- Optional mobile-vs-desktop PageSpeed comparison is visible.
- Launch-readiness prioritized fix ordering is visible.
- Report ID is visible in report metadata.

## V9 preservation rule
V9 was produced by surgical additive changes on top of V8. Agent A (7) was not used as a replacement base.
