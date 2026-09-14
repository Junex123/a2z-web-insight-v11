import type { FetchResult, FetchQuality, HtmlAnalysis } from "../types.js";

/**
 * Distinguishes "a real page, however minimal" from "an empty or
 * content-free response that happened to return HTTP 200 with a
 * text/html content-type." Session 9 addition - see
 * PROJECT_PROGRESS.md.
 *
 * WHY THIS EXISTS: collectHttp() already fails closed for the clearly
 * broken cases - a non-HTML content-type throws NON_HTML, a timeout
 * throws TARGET_TIMEOUT, an unreachable host throws TARGET_UNREACHABLE,
 * and NONE of those ever reach detectIssues()/detectAccessibilityIssues()
 * (routes/analyze.ts turns them into an HTTP error response before any
 * report is built - see PROJECT_PROGRESS.md's error-model notes).
 *
 * The gap this closes is narrower and easy to miss: a response that
 * returns HTTP 200, a text/html content-type, and IS successfully
 * read - but whose body is empty or has no analyzable structure at
 * all (a WAF/bot-challenge page reacting to this scanner's traffic is
 * a realistic real-world cause, though this classifier has no way to
 * know the cause, only the symptom). Before this, such a response
 * flowed through the SAME code path as a real page - detectIssues()
 * would generate a full, normal-looking pile of "missing title,"
 * "missing meta description," etc. SEO findings, scored normally, with
 * nothing in the report distinguishing "we verified this page has bad
 * SEO" from "we have no idea, because there was nothing here to check."
 *
 * DELIBERATELY NOT BYTE-COUNT-BASED AS THE PRIMARY SIGNAL. A real,
 * legitimate minimal page can be genuinely small (this project's own
 * `/clean` fixture is 663 bytes and is a perfectly real, analyzable
 * page - title, meta description, canonical, h1, and an image with
 * alt text all present). Byte count alone would misclassify it as
 * "insufficient." The primary signal is structural: does the parsed
 * HTML have ANY of title/h1/meta-description/images at all? A response
 * with literally none of those is almost certainly not a real page,
 * regardless of its byte size (a JS-heavy SPA shell technically has
 * this same shape too - see the Known Limitations note on this in
 * PROJECT_PROGRESS.md; this classifier is about the STATIC HTTP fetch
 * only, and Session 6's browser-based content comparison already
 * exists as a separate, complementary signal for that case when
 * browser verification is requested).
 */
export function classifyFetchQuality(fetchResult: FetchResult, html: HtmlAnalysis): FetchQuality {
  if (fetchResult.bodyBytes === 0) return "empty";

  const hasAnyStructure = !!html.title || html.h1Count > 0 || !!html.metaDescription || html.images.total > 0;
  if (!hasAnyStructure) return "insufficient";

  return "usable";
}
