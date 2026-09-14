# A-to-Z Web Insight — Merge V5

## Baseline

`a2z-web-insight-final-upgraded-v4.zip` is the primary code baseline because it contains the previously integrated browser, responsive, UX, launch-readiness, correlation, SEO, performance, security, and accessibility layers.

## New sources reviewed

- `a2z-web-insight-session19.zip`: newest supplied Session 19 security work.
- `a2z-web-insight-agent-a (3)(3).zip`: Agent A/Godeels audit and launch/correlation-era implementation reference.
- `a2z-web-insight-session10(3).zip`: historical browser/Playwright reference.

## Ported into V5

From Session 19, only verified security capabilities missing from V4 were promoted:

- Permissions-Policy detection for sensitive features explicitly wildcarded to any origin.
- Reverse-tabnabbing detection for `target="_blank"` links without explicit `noopener`/`noreferrer`.
- Corresponding security types, verification state, analysis rules, and focused tests.

## Deliberately not replaced

- V4 browser/Playwright infrastructure was preserved.
- V4 responsive/mobile/desktop infrastructure was preserved.
- V4 UX infrastructure was preserved.
- V4 launch-readiness and cross-category correlation were preserved.
- V4 richer HTML/SEO implementation was preserved.
- V4 security implementation was preserved rather than replaced by the smaller Session 19 snapshot.

## Validation

Run `npm install`, `npm run typecheck`, and `npm test` in `server/` on the user's Windows environment. Do not treat a sandbox dependency failure as a product failure.
