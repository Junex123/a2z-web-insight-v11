/**
 * Thresholds for the mobile/desktop responsiveness checks. Centralized
 * here, same pattern as performanceThresholds.ts / resourceThresholds.ts,
 * so nobody hunts for a magic pixel count buried in a rule file.
 *
 * IMPORTANT: unlike performanceThresholds.ts (which is built on
 * published, well-established Core Web Vitals boundaries), these are
 * NOT industry-standard numbers - there is no equivalent authoritative
 * source for "how many pixels wide is too fixed" or "how many nav
 * links is too many for mobile." They are reasonable, conservative
 * heuristics chosen to minimize false positives, documented as such,
 * and every finding built from them is worded as a *risk*, never a
 * proven defect (see analysis/responsiveIssues.ts).
 */

/** A numeric CSS width above this (in px) on a fixed (non-percentage) declaration is flagged as a mobile risk. */
export const FIXED_WIDTH_RISK_PX = 600;

/** A numeric CSS width above this (in px) is flagged as an excessive-fixed-width desktop risk. */
export const DESKTOP_FIXED_WIDTH_RISK_PX = 1600;

/** An <img width="..."> attribute above this (in px) combined with no srcset/sizes is flagged. */
export const LARGE_STATIC_IMAGE_WIDTH_PX = 1200;

/** A single <nav> with more direct link children than this is flagged as a likely un-collapsed desktop-style menu. */
export const LARGE_FLAT_NAV_LINK_COUNT = 10;

/** Bounded external-stylesheet fetch limit per scan - see responsiveCollector.ts. */
export const MAX_EXTERNAL_STYLESHEETS = 3;
