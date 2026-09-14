import { Router, type Request, type Response } from "express";
import { CollectorError, type CollectorErrorCode } from "../collectors/httpCollector.js";
import { analyzeUrl } from "../pipeline.js";

export const analyzeRouter = Router();

export const STATUS_BY_CODE: Record<CollectorErrorCode, number> = {
  INVALID_URL: 400,
  BLOCKED_HOST: 400,
  DNS_ERROR: 502,
  TARGET_TIMEOUT: 504,
  TARGET_UNREACHABLE: 502,
  NON_HTML: 415,
};

analyzeRouter.post("/analyze", async (req: Request, res: Response) => {
  const { url, includeBrowserVerification, browserVerificationOptions } = req.body ?? {};

  if (typeof url !== "string" || url.trim().length === 0) {
    return res.status(400).json({ error: "Request body must include a non-empty 'url' string.", code: "INVALID_URL" });
  }

  try {
    const report = await analyzeUrl(url.trim(), {
      includeBrowserVerification: includeBrowserVerification === true,
      browserVerificationOptions: typeof browserVerificationOptions === "object" && browserVerificationOptions !== null ? browserVerificationOptions : undefined,
    });
    return res.json(report);
  } catch (err) {
    if (err instanceof CollectorError) {
      // CollectorError messages are already user-safe (no stack traces,
      // no internal paths, no secrets) - see httpCollector.ts.
      return res.status(STATUS_BY_CODE[err.code]).json({ error: err.message, code: err.code });
    }
    // Never leak a raw stack trace / internal detail to the client.
    console.error("Unexpected analyze failure:", err);
    return res.status(500).json({ error: "Unexpected server error while analyzing the URL.", code: "INTERNAL_ERROR" });
  }
});
