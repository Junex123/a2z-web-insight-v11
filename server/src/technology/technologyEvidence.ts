import type { TechnologyEvidence, TechnologyConfidence, SignalType } from './types.js';

const MAX_EVIDENCE_LENGTH = 180;

/**
 * Patterns for values that must never appear in a report, even truncated.
 * Technology evidence is user-visible and may be exported.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+/g,   // Stripe-style keys
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,          // bearer tokens
  /\beyJ[A-Za-z0-9._-]{10,}/g,                  // JWTs
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // emails
  /\b(?:password|secret|token|apikey|api_key)=[^&\s;]+/gi,
];

export function redact(value: string): string {
  let out = value;
  for (const p of SENSITIVE_PATTERNS) out = out.replace(p, '[redacted]');
  return out;
}

export function truncate(value: string, max = MAX_EVIDENCE_LENGTH): string {
  const v = value.trim().replace(/\s+/g, ' ');
  return v.length <= max ? v : `${v.slice(0, max - 1)}…`;
}

export function makeEvidence(params: {
  signalType: SignalType;
  source: string;
  matched: string;
  confidence: TechnologyConfidence;
  capturedVersion?: string;
}): TechnologyEvidence {
  return {
    signalType: params.signalType,
    source: params.source,
    matched: truncate(redact(params.matched)),
    confidence: params.confidence,
    ...(params.capturedVersion ? { capturedVersion: params.capturedVersion } : {}),
  };
}

/**
 * Cookie evidence is name-only by construction — there is no code path
 * that accepts a cookie value.
 */
export function makeCookieEvidence(
  cookieName: string,
  source: string,
  confidence: TechnologyConfidence,
): TechnologyEvidence {
  return makeEvidence({
    signalType: 'cookie-name',
    source,
    matched: `cookie name: ${cookieName}`,
    confidence,
  });
}
