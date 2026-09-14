import { Router, type Request, type Response } from "express";
import { CollectorError, type CollectorErrorCode } from "../collectors/httpCollector.js";
import { analyzeSite } from "../sitePipeline.js";
import type { CrawlOptions } from "../types.js";

export const analyzeSiteRouter = Router();

const STATUS_BY_CODE: Record<CollectorErrorCode, number> = {
  INVALID_URL: 400,
  BLOCKED_HOST: 400,
  DNS_ERROR: 502,
  TARGET_TIMEOUT: 504,
  TARGET_UNREACHABLE: 502,
  NON_HTML: 415,
};

/** Hard server-side ceilings, regardless of what the client requests - a site crawl is much heavier than a single-page scan. */
const MAX_PAGES_CEILING = 50;
const MAX_DEPTH_CEILING = 10;

function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.floor(value), min), max);
}

analyzeSiteRouter.post("/analyze-site", async (req: Request, res: Response) => {
  const { url, maxPages, maxDepth } = req.body ?? {};

  if (typeof url !== "string" || url.trim().length === 0) {
    return res.status(400).json({ error: "Request body must include a non-empty 'url' string.", code: "INVALID_URL" });
  }

  const overrides: Partial<CrawlOptions> = {};
  const clampedMaxPages = clampInt(maxPages, 1, MAX_PAGES_CEILING);
  const clampedMaxDepth = clampInt(maxDepth, 0, MAX_DEPTH_CEILING);
  if (clampedMaxPages !== undefined) overrides.maxPages = clampedMaxPages;
  if (clampedMaxDepth !== undefined) overrides.maxDepth = clampedMaxDepth;

  try {
    const report = await analyzeSite(url.trim(), overrides);
    return res.json(report);
  } catch (err) {
    if (err instanceof CollectorError) {
      return res.status(STATUS_BY_CODE[err.code]).json({ error: err.message, code: err.code });
    }
    console.error("Unexpected analyze-site failure:", err);
    return res.status(500).json({ error: "Unexpected server error while analyzing the site.", code: "INTERNAL_ERROR" });
  }
});
