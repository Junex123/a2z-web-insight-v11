import type { DetectionRule } from '../technologyRegistry.js';
import { makeEvidence, makeCookieEvidence } from '../technologyEvidence.js';
import type { TechnologyInput, TechnologyEvidence, TechnologyRequestManifest } from '../types.js';
import { FULL_REGISTRY } from '../registry/compose.js';
import { evaluateRule } from '../technologyDetector.js';

/**
 * PERFORMANCE (§20): every surface is derived once per input and reused
 * across all rules. No rule re-scans the raw HTML.
 */
export interface Surfaces {
  html: string;
  inlineScripts: string;
  cssText: string;
  robots: string;
  urlPath: string;
  xhrHosts: string[];
  certIssuer: string;
  selectors: Set<string>;
  jsProps: Map<string, string | boolean>;
  probes: Record<string, { status: number; bodySnippet?: string }>;
}

export function buildSurfaces(input: TechnologyInput): Surfaces {
  let urlPath = '';
  try { urlPath = new URL(input.url).pathname; } catch { urlPath = input.url; }
  return {
    html: input.html ?? '',
    inlineScripts: (input.inlineScripts ?? []).join('\n'),
    cssText: (input.cssText ?? []).join('\n'),
    robots: input.robotsTxt ?? '',
    urlPath,
    xhrHosts: (input.xhrHosts ?? []).map((h) => h.toLowerCase()).sort(),
    certIssuer: input.certificateIssuer ?? '',
    selectors: new Set(input.presentSelectors ?? []),
    jsProps: new Map(Object.entries(input.presentJsProperties ?? {})),
    probes: input.probeResults ?? {},
  };
}

export interface ExtendedMatch {
  evidence: TechnologyEvidence;
  version?: string;
}

/** Evaluates rules whose signal type the V10 base detector does not handle. */
export function evaluateExtendedRule(
  rule: DetectionRule & { versionFromProperty?: boolean },
  s: Surfaces,
  input: TechnologyInput,
): ExtendedMatch | undefined {
  const cap = (m: RegExpMatchArray) => (rule.versionGroup ? m[rule.versionGroup] : undefined);
  const ev = (matched: string, version?: string): ExtendedMatch => ({
    evidence: makeEvidence({
      signalType: rule.type, source: rule.source, matched,
      confidence: rule.confidence, capturedVersion: version,
    }),
    version,
  });

  switch (rule.type) {
    case 'robots-txt': {
      if (!s.robots) return undefined;
      const m = s.robots.match(rule.pattern);
      return m ? ev(`robots.txt: ${m[0]}`, cap(m)) : undefined;
    }
    case 'url-pattern': {
      const m = s.urlPath.match(rule.pattern);
      return m ? ev(`URL path: ${s.urlPath}`, cap(m)) : undefined;
    }
    case 'inline-script': {
      if (!s.inlineScripts) return undefined;
      const m = s.inlineScripts.match(rule.pattern);
      return m ? ev(`inline script: ${m[0]}`, cap(m)) : undefined;
    }
    case 'css-rule': {
      if (!s.cssText) return undefined;
      const m = s.cssText.match(rule.pattern);
      return m ? ev(`stylesheet rule: ${m[0]}`, cap(m)) : undefined;
    }
    case 'cert-issuer': {
      if (!s.certIssuer) return undefined;
      return rule.pattern.test(s.certIssuer)
        ? ev(`certificate issuer: ${s.certIssuer}`) : undefined;
    }
    case 'xhr-host': {
      for (const h of s.xhrHosts) {
        if (rule.pattern.test(h)) return ev(`XHR host: ${h}`);
      }
      return undefined;
    }
    case 'dom-selector': {
      // Selector presence is resolved by V10's browser layer, never here.
      for (const sel of s.selectors) {
        if (rule.pattern.test(sel)) return ev(`DOM selector present: ${sel}`);
      }
      return undefined;
    }
    case 'js-property': {
      for (const [path, value] of s.jsProps) {
        if (!rule.pattern.test(path)) continue;
        const version =
          rule.versionFromProperty && typeof value === 'string' ? value : undefined;
        return ev(`JS property present: ${path}`, version);
      }
      return undefined;
    }
    case 'probe': {
      const result = s.probes[rule.source];
      if (!result) return undefined; // probe not executed → no detection
      if (rule.expectStatus !== undefined && result.status !== rule.expectStatus) return undefined;
      if (!result.bodySnippet) return ev(`probe ${rule.source}: HTTP ${result.status}`);
      const m = result.bodySnippet.match(rule.pattern);
      return m ? ev(`probe ${rule.source}: ${m[0]}`, cap(m)) : undefined;
    }
    default:
      // Reuse the canonical V10 evaluator for legacy signal surfaces added by
      // overlays/extensions. The orchestrator deduplicates evidence already
      // produced by the base pass, so running a base-type overlay is safe.
      return evaluateRule(rule, input);
  }
}

/**
 * §1 SAFETY: the engine never fetches, never evaluates JS, never touches the
 * DOM. It publishes what it needs; V10 resolves it with existing controls.
 */
function exactPatternLiteral(source: string): string {
  return source.replace(/^\^|\$$/g, '').replace(/\\([\W_])/g, '$1');
}

export function requestManifest(): TechnologyRequestManifest {
  const selectors = new Set<string>();
  const jsProperties = new Set<string>();
  const probes: TechnologyRequestManifest['probes'] = [];

  for (const t of FULL_REGISTRY) {
    for (const r of t.extendedRules) {
      if (r.type === 'dom-selector') selectors.add(exactPatternLiteral(r.pattern.source));
      if (r.type === 'js-property') jsProperties.add(exactPatternLiteral(r.pattern.source));
      if (r.type === 'probe' && r.probePath) {
        probes.push({ id: r.source, path: r.probePath, expectStatus: r.expectStatus });
      }
    }
  }
  return {
    selectors: [...selectors].sort(),
    jsProperties: [...jsProperties].sort(),
    probes: probes.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
