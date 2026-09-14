import type { Severity } from "../types.js";

/**
 * Thresholds for resource-level performance findings (JS/CSS/image/
 * font/third-party payload sizes, render-blocking time, unused code,
 * caching). These are approximate, well-established reference points
 * (HTTP Archive median payload sizes, Lighthouse's own scoring
 * curves) - centralized here, same pattern as
 * analysis/performanceThresholds.ts for Core Web Vitals, so nobody
 * hunts for a magic byte count buried in a rule file. They are
 * intentionally coarse (two bands: "needs improvement" / "poor") to
 * avoid false precision around a boundary - see README Definition of
 * Done: "do not turn a tiny difference around a threshold into a
 * dramatically different severity without reason."
 */

export interface ByteThreshold {
  /** bytes at/below which this is not flagged at all */
  needsImprovement: number;
  /** bytes above which this is "poor" (critical/high) rather than "needs improvement" (medium) */
  poor: number;
}

export const JS_TRANSFER_BYTES: ByteThreshold = { needsImprovement: 300_000, poor: 600_000 };
export const CSS_TRANSFER_BYTES: ByteThreshold = { needsImprovement: 100_000, poor: 250_000 };
export const IMAGE_TRANSFER_BYTES: ByteThreshold = { needsImprovement: 1_000_000, poor: 2_000_000 };
export const FONT_TRANSFER_BYTES: ByteThreshold = { needsImprovement: 150_000, poor: 300_000 };
export const TOTAL_PAGE_WEIGHT_BYTES: ByteThreshold = { needsImprovement: 1_600_000, poor: 3_000_000 };
export const THIRD_PARTY_TRANSFER_BYTES: ByteThreshold = { needsImprovement: 300_000, poor: 800_000 };

export const UNUSED_CSS_BYTES: ByteThreshold = { needsImprovement: 20_000, poor: 100_000 };
export const UNUSED_JS_BYTES: ByteThreshold = { needsImprovement: 50_000, poor: 200_000 };
export const UNMINIFIED_BYTES: ByteThreshold = { needsImprovement: 10_000, poor: 50_000 };

export const RENDER_BLOCKING_WASTED_MS = { needsImprovement: 300, poor: 600 };
export const THIRD_PARTY_BLOCKING_MS = { needsImprovement: 250, poor: 600 };

/** Lighthouse's own dom-size audit scoring bands (element count). */
export const DOM_SIZE = { needsImprovement: 800, poor: 1500 };
/** Lighthouse's mainthread-work-breakdown / bootup-time scoring bands, in ms. */
export const MAIN_THREAD_WORK_MS = { needsImprovement: 2000, poor: 4000 };
export const BOOTUP_TIME_MS = { needsImprovement: 2000, poor: 3500 };

/** Any wasted bytes from short/missing cache lifetimes on fingerprinted/static assets is worth flagging. */
export const LONG_CACHE_TTL_WASTED_BYTES_FLOOR = 20_000;
export const TEXT_COMPRESSION_SAVINGS_BYTES_FLOOR = 10_000;
export const MODERN_IMAGE_FORMAT_SAVINGS_BYTES_FLOOR = 50_000;
export const OFFSCREEN_IMAGE_SAVINGS_BYTES_FLOOR = 50_000;
export const RESPONSIVE_IMAGE_SAVINGS_BYTES_FLOOR = 50_000;

export function severityForByteThreshold(value: number, t: ByteThreshold, poorSeverity: Severity = "high"): Severity | null {
  if (value <= t.needsImprovement) return null;
  return value > t.poor ? poorSeverity : "medium";
}

export function severityForMsThreshold(
  value: number,
  t: { needsImprovement: number; poor: number },
  poorSeverity: Severity = "high",
): Severity | null {
  if (value <= t.needsImprovement) return null;
  return value > t.poor ? poorSeverity : "medium";
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)}MB`;
  return `${Math.round(bytes / 1000)}KB`;
}
