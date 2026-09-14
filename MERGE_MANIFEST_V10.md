# A-to-Z Web Insight V10 Merge Manifest

Canonical baseline: V9 (`a2z-web-insight-final-merged-v9(1).zip`)

This merge is additive. Existing V9 analyzers, scoring, crawler, launch decision, evidence model, and frontend report remain intact.

## Added capabilities

### Technology Intelligence
- Deterministic technology registry and detector under `server/src/technology/`.
- 38 technology/tool definitions across CMS, frameworks/libraries, analytics, ecommerce, payments, infrastructure, and other tooling.
- Evidence-backed detection from HTML, meta generators, headers, cookies (names only), scripts, stylesheets, resource URLs, request hosts, DOM markers, and browser runtime markers.
- Conservative confidence model, version arbitration, implication graph, false-positive resistance, evidence redaction/truncation.
- Runtime browser markers for React/jQuery/Vue and related DOM fingerprints are collected only from a small allowlist.
- Technology detections are exposed on the canonical `AnalysisReport.technology` field and rendered in the existing vanilla frontend.
- Technology icon/name links to the registry's official homepage. Icons resolve from Simple Icons CDN with a local initial-letter fallback when unavailable.

### Earlier accepted deltas preserved
- Agent 3 combined security correlations:
  - reflected arbitrary CORS + sensitive SameSite=None+Secure cookie
  - permissive/no CSP script execution + sensitive cookie missing HttpOnly
- Resource ETag is now consumed for a distinct validator-only cache diagnostic rather than being collected and ignored.
- `<picture><source srcset>` candidates are now included in bounded resource probing.

## Validation
- JavaScript syntax check: `node --check client/app.js` passed.
- TypeScript syntax/transpile check using the installed TypeScript compiler API passed for all modified TypeScript files.
- Full `npm test` and `npm run typecheck` could not be executed because this sandbox could not install the project's npm dependencies; `npm install` timed out and offline install was not cached.
- No test output is claimed as passed unless actually observed.

## Deliberately not merged
The 2026 external correctness oracle items (FAQPage deprecation, WCAG 4.1.1 reclassification, HSTS preload eligibility, obsolete security-header ledger, sitemap uncompressed limits, etc.) were not blindly applied where V9 source did not demonstrate an existing conflicting rule. They remain candidates for a subsequent verified audit rather than speculative changes.
