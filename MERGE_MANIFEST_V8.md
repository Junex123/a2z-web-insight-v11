# V8 MERGE MANIFEST

Base: a2z-web-insight-final-merged-v5(1).zip
Reviewed against: a2z-web-insight-final-merged-2026-08-29-v7.zip

## Merge policy
V5 remains the intact capability baseline. Only verified V7 improvements that do not remove baseline capabilities are promoted.

## Changes
1. `server/src/analysis/resourceIssues.ts` now supports an optional set of image URLs already explained by a more-specific finding.
2. `server/src/pipeline.ts` passes the actual PageSpeed LCP image URL into that exclusion set, preventing one root cause from generating a second grouped image-optimization deduction.
3. `server/test/securityHeaderQuality.test.ts` is carried forward from V7 because the V5 security implementation already supports the tested behavior.
4. `MASTER_CAPABILITY_INVENTORY.md` documents preserved capabilities and merge rules.

## Rejected as regressions
The V7 versions of `package.json`, `pipeline.ts`, `types.ts`, and other shared files were not copied wholesale because they removed or bypassed browser/mobile, UX, responsive, runtime verification, fetch-quality, and security-collector functionality present in the V5 baseline.

## Validation status
Archive integrity verified after creation. Full npm test/typecheck/runtime validation must be run in the user's Windows environment with dependencies installed.
