# Incremental Merge Notes — 2026-08-23

Baseline: a2z-web-insight-final-upgraded-incremental.zip

Integrated only capabilities that were genuinely newer than the baseline:
- Session 9 performance opportunities/root-cause grouping and fix-priority presentation, wired into the existing single-page pipeline; site-wide opportunity fields are additive and wired through the existing site pipeline.
- SEO Session 12 LCP-element extraction and independently cross-verified LCP image root-cause enrichment.
- Agent A Sessions 12-13 cross-category root-cause correlation and correlation-aware fix prioritization.
- Session 14 real TLS certificate inspection, DNS CAA checks, and cross-origin SRI detection, including the regression fixtures/tests.

Deliberately NOT used:
- Older wholesale versions of shared files from the uploaded archives that would have removed newer UX, responsiveness, browser/runtime, fetch-quality, crawler, or other baseline work.
- No dependency changes were introduced because all merged capabilities use existing dependencies / Node built-ins.

Verification in this merge environment:
- Static file/import presence checks performed.
- Full npm test/typecheck was not claimed here because this merge environment does not have the project's installed dependency tree.
- Run on the user's machine: cd server; npm install; npm run typecheck; npm test.
