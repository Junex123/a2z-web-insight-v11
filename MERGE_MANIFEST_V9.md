# V9 MERGE MANIFEST

Base: a2z-web-insight-final-merged-v8.zip
Upgrade source: a2z-web-insight-agent-a (7).zip

## Merge policy
V8 remains the canonical capability baseline. Agent A (7) is treated as an upgrade proposal only. No shared backend file from Agent A (7) was copied wholesale because that ZIP predates/omits capabilities already present in V8.

## Promoted changes
1. Added frontend rendering for the existing `launchDecision` status/banner.
2. Added per-category launch-readiness pills using the existing `categoryReadiness` data.
3. Added frontend rendering for `scanCompleteness`, `notVerified`, and `overallVerification`.
4. Added frontend rendering for existing cross-category `correlatedFindings`.
5. Added frontend rendering for the existing optional desktop PageSpeed comparison and `mobileDesktopGaps`.
6. Added frontend rendering for the existing `prioritizedFixes` launch-readiness ordering.
7. Added `reportId` to the existing report metadata line.

## Explicitly preserved
- V8 backend collectors and analyzers.
- Browser/runtime verification.
- Mobile/responsive analysis.
- UX/security/SEO/resource/site-wide modules.
- V8 launch-decision backend implementation and six-category model.
- Existing accessibility landmark/skip-link/heading/fieldset checks.
- Existing tests and dependencies.

## Explicitly rejected as regressions
The Agent A (7) versions of shared `pipeline.ts`, `types.ts`, `launchDecision.ts`, `client/app.js`, and other shared files were NOT copied wholesale. Its branch removes or bypasses V8 capabilities. Only the missing additive frontend pieces were surgically ported.

## Validation
The merge was structurally assembled from V8 plus the isolated Agent A additions. Full npm install/typecheck/test/runtime validation must be run on the user's Windows environment before calling this release fully verified.
