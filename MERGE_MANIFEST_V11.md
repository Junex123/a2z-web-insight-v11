# A-to-Z Web Insight V11 Merge Manifest

## Canonical baseline
V10 is preserved as the baseline. This merge is additive and keeps the existing deterministic audit pipeline, security correlations, ETag/cache intelligence, picture/source resource coverage, site crawler, launch readiness, verification, and existing Technology Intelligence detector.

## Technology Intelligence V11
- Extended technology model with evidence roles, version provenance, relationships, metadata, audit relevance, risk metadata, site-wide coverage and neutral variance observations.
- Extended fingerprint surfaces: DOM selectors, JS properties, CSS, robots.txt, URL paths, XHR/fetch hosts, certificate issuer contract, inline scripts, and bounded probe contract.
- Registry graph validation for requires/implies/excludes/dependency categories/cycles.
- Registry composition deduplicates technologies already present in V10 instead of creating duplicate graph nodes.
- 80 canonical composed technology definitions in the merged registry, including V10 detections plus the expanded technology families supplied in the V11 upgrade.
- Deterministic explanations and version forensics.
- Page-level and site-wide technology aggregation.
- Technology search/category/confidence filtering in the existing vanilla frontend.
- Existing technology cards retain official-homepage links, icons, evidence, confidence, and version display while gaining richer forensic details.

## Browser integration
The existing Playwright runtime collector now resolves an allowlisted technology request manifest for DOM selectors and JS property paths. It never serializes arbitrary DOM state. Existing SSRF and browser request controls remain authoritative.

## Site integration
Site analysis aggregates technology intelligence from the exact same per-page AnalysisReport objects already produced by the V10 crawler.

## Validation performed
- Technology subtree TypeScript compilation: PASS via dedicated NodeNext build.
- Registry graph validation: PASS (0 graph issues).
- Runtime technology checks: PASS.
- Client JavaScript syntax check: PASS.
- Node/Playwright full project dependency installation: unavailable in sandbox; full V10 npm test/typecheck suite was therefore not executed.

## Known limitation
Full project validation still requires a machine with the project's dependencies installed. This manifest does not claim a green full-suite result.
