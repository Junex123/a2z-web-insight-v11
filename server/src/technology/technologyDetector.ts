import {
  TECHNOLOGY_REGISTRY,
  REGISTRY_BY_SLUG,
  type TechnologyDefinition,
  type DetectionRule,
} from './technologyRegistry.js';
import { makeEvidence, makeCookieEvidence } from './technologyEvidence.js';
import { categoryOrder } from './technologyCategories.js';
import type {
  TechnologyInput,
  TechnologyDetection,
  TechnologyEvidence,
  TechnologyIntelligence,
  TechnologyConfidence,
  TechnologyCategoryId,
} from './types.js';

const CONFIDENCE_RANK: Record<TechnologyConfidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const VERSION_SHAPE = /^\d+(?:\.\d+){0,3}$/;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function headerValue(
  headers: TechnologyInput['headers'],
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower || v === undefined) continue;
    return Array.isArray(v) ? v.join(', ') : String(v);
  }
  return undefined;
}

function generatorContents(input: TechnologyInput): string[] {
  return (input.metaTags ?? [])
    .filter((m) => (m.name ?? '').toLowerCase() === 'generator')
    .map((m) => m.content)
    .filter(Boolean);
}

function urlsFor(rule: DetectionRule, input: TechnologyInput): string[] {
  switch (rule.type) {
    case 'script-url':
      return input.scriptUrls ?? [];
    case 'stylesheet-url':
      return input.stylesheetUrls ?? [];
    case 'resource-url':
      return [
        ...(input.resourceUrls ?? []),
        ...(input.scriptUrls ?? []),
        ...(input.stylesheetUrls ?? []),
      ];
    default:
      return [];
  }
}

export interface RuleMatch {
  evidence: TechnologyEvidence;
  version?: string;
}

export function evaluateRule(
  rule: DetectionRule,
  input: TechnologyInput,
): RuleMatch | undefined {
  // Single-group contract: versionGroup always refers to group 1 in practice,
  // and the registry test enforces exactly one capture group when it is set.
  const capture = (m: RegExpMatchArray): string | undefined =>
    rule.versionGroup ? m[rule.versionGroup] : undefined;

  switch (rule.type) {
    case 'meta-generator': {
      for (const content of generatorContents(input)) {
        const m = content.match(rule.pattern);
        if (!m) continue;
        const v = capture(m);
        return {
          evidence: makeEvidence({
            signalType: rule.type,
            source: rule.source,
            matched: `<meta name="generator" content="${content}">`,
            confidence: rule.confidence,
            capturedVersion: v,
          }),
          version: v,
        };
      }
      return undefined;
    }

    case 'response-header': {
      if (!rule.header) return undefined;
      const value = headerValue(input.headers, rule.header);
      if (value === undefined) return undefined;
      const m = value.match(rule.pattern);
      if (!m) return undefined;
      const v = capture(m);
      return {
        evidence: makeEvidence({
          signalType: rule.type,
          source: rule.source,
          matched: `${rule.header}: ${value}`,
          confidence: rule.confidence,
          capturedVersion: v,
        }),
        version: v,
      };
    }

    case 'cookie-name': {
      for (const name of input.cookieNames ?? []) {
        if (!rule.pattern.test(name)) continue;
        return { evidence: makeCookieEvidence(name, rule.source, rule.confidence) };
      }
      return undefined;
    }

    case 'script-url':
    case 'stylesheet-url':
    case 'resource-url': {
      for (const url of urlsFor(rule, input)) {
        const m = url.match(rule.pattern);
        if (!m) continue;
        // The former `?? m[2]` fallback is gone; patterns now expose one group.
        const v = capture(m);
        return {
          evidence: makeEvidence({
            signalType: rule.type,
            source: rule.source,
            matched: url,
            confidence: rule.confidence,
            capturedVersion: v,
          }),
          version: v,
        };
      }
      return undefined;
    }

    case 'request-host': {
      const hosts = new Set<string>(
        (input.requestHosts ?? []).map((h) => h.toLowerCase()),
      );
      for (const list of [input.scriptUrls, input.stylesheetUrls, input.resourceUrls]) {
        for (const u of list ?? []) {
          const h = hostOf(u);
          if (h) hosts.add(h);
        }
      }
      // Sorted for deterministic evidence when several hosts match.
      for (const h of [...hosts].sort()) {
        if (!rule.pattern.test(h)) continue;
        return {
          evidence: makeEvidence({
            signalType: rule.type,
            source: rule.source,
            matched: `request host: ${h}`,
            confidence: rule.confidence,
          }),
        };
      }
      return undefined;
    }

    case 'html-marker': {
      if (!input.html) return undefined;
      const m = input.html.match(rule.pattern);
      if (!m) return undefined;
      const v = capture(m);
      return {
        evidence: makeEvidence({
          signalType: rule.type,
          source: rule.source,
          matched: m[0],
          confidence: rule.confidence,
          capturedVersion: v,
        }),
        version: v,
      };
    }

    case 'runtime-global': {
      const names = [
        ...(input.runtime?.globals ?? []),
        ...(input.runtime?.domMarkers ?? []),
      ];
      for (const name of names) {
        if (!rule.pattern.test(name)) continue;
        // Contract: runtime.versions is keyed by the LOWERCASED marker name.
        const reported = input.runtime?.versions?.[name.toLowerCase()];
        return {
          evidence: makeEvidence({
            signalType: rule.type,
            source: rule.source,
            matched: `runtime marker: ${name}`,
            confidence: rule.confidence,
            capturedVersion: reported,
          }),
          version: reported,
        };
      }
      return undefined;
    }

    case 'dom-attribute': {
      if (!rule.attribute) return undefined;
      for (const attr of input.domAttributes ?? []) {
        if (attr.name.toLowerCase() !== rule.attribute.toLowerCase()) continue;
        const m = attr.value.match(rule.pattern);
        if (!m) continue;
        const v = capture(m);
        return {
          evidence: makeEvidence({
            signalType: rule.type,
            source: rule.source,
            matched: `${attr.name}="${attr.value}"`,
            confidence: rule.confidence,
            capturedVersion: v,
          }),
          version: v,
        };
      }
      return undefined;
    }

    case 'class-fingerprint': {
      if (!input.html) return undefined;
      // Registry patterns are never global; a fresh global copy is built here
      // so no lastIndex state can leak between inputs.
      const re = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
      const distinct = new Set<string>();
      for (const m of input.html.matchAll(re)) distinct.add(m[0]);
      if (distinct.size < (rule.minDistinctMatches ?? 1)) return undefined;
      return {
        evidence: makeEvidence({
          signalType: rule.type,
          source: rule.source,
          matched: `${distinct.size} distinct utility classes: ${[...distinct]
            .sort()
            .slice(0, 6)
            .join(', ')}`,
          confidence: rule.confidence,
        }),
      };
    }

    case 'implied-by':
      // Detector-generated only; never valid as a registry rule.
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Confidence:
 *   base = highest single-signal confidence
 *   promote to HIGH when >= 2 signal types, each >= MEDIUM, rest on
 *   DISTINCT observations. Deduplicating by matched value prevents two
 *   rules that hit the same URL from faking independent corroboration.
 */
function resolveConfidence(evidence: TechnologyEvidence[]): TechnologyConfidence {
  let base: TechnologyConfidence = 'low';
  for (const e of evidence) {
    if (CONFIDENCE_RANK[e.confidence] > CONFIDENCE_RANK[base]) base = e.confidence;
  }
  if (base === 'high') return 'high';

  const corroborating = evidence.filter((e) => CONFIDENCE_RANK[e.confidence] >= 2);
  const distinctTypes = new Set(corroborating.map((e) => e.signalType));
  const distinctObservations = new Set(corroborating.map((e) => e.matched));

  return distinctTypes.size >= 2 && distinctObservations.size >= 2 ? 'high' : base;
}

/**
 * Version arbitration. Malformed versions are discarded. Prefix-compatible
 * versions collapse to the most specific ("10" + "10.2.1" -> "10.2.1"),
 * which fixes a false omission for products that report a bare major in one
 * header and a full version in another. Genuinely conflicting versions are
 * still omitted entirely.
 */
function resolveVersion(matches: RuleMatch[]): string | undefined {
  const valid = [
    ...new Set(
      matches
        .map((m) => m.version?.trim())
        .filter((v): v is string => Boolean(v) && VERSION_SHAPE.test(v!)),
    ),
  ].sort((a, b) => b.length - a.length || a.localeCompare(b));

  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];

  const longest = valid[0];
  const allCompatible = valid.every(
    (v) => v === longest || longest.startsWith(`${v}.`),
  );
  return allCompatible ? longest : undefined;
}

function detectOne(
  def: TechnologyDefinition,
  input: TechnologyInput,
): { detection: TechnologyDetection; rulesEvaluated: number } {
  const matches: RuleMatch[] = [];
  for (const rule of def.rules) {
    const m = evaluateRule(rule, input);
    if (m) matches.push(m);
  }

  const evidence = matches.map((m) => m.evidence);
  const version = resolveVersion(matches);

  return {
    rulesEvaluated: def.rules.length,
    detection: {
      slug: def.slug,
      name: def.name,
      category: def.category,
      icon: def.icon,
      homepage: def.homepage,
      ...(version ? { version } : {}),
      confidence: resolveConfidence(evidence),
      evidence,
      implied: false,
    },
  };
}

export function detectTechnologies(input: TechnologyInput): TechnologyIntelligence {
  const found = new Map<string, TechnologyDetection>();
  let signalsEvaluated = 0;

  for (const def of TECHNOLOGY_REGISTRY) {
    const { detection, rulesEvaluated } = detectOne(def, input);
    signalsEvaluated += rulesEvaluated;
    if (detection.evidence.length === 0) continue; // never report without a signal
    found.set(def.slug, detection);
  }

  // Implications, from >= medium detections only. Iterating the registry
  // (not the Map) keeps this order-independent.
  for (const def of TECHNOLOGY_REGISTRY) {
    const det = found.get(def.slug);
    if (!det || det.implied) continue;
    if (CONFIDENCE_RANK[det.confidence] < 2) continue;

    for (const impliedSlug of def.implies ?? []) {
      const impliedDef = REGISTRY_BY_SLUG.get(impliedSlug);
      if (!impliedDef || found.has(impliedSlug)) continue;

      found.set(impliedSlug, {
        slug: impliedDef.slug,
        name: impliedDef.name,
        category: impliedDef.category,
        icon: impliedDef.icon,
        homepage: impliedDef.homepage,
        confidence: 'medium', // implications never reach high
        implied: true,
        evidence: [
          makeEvidence({
            signalType: 'implied-by',
            source: `implied by ${det.name}`,
            matched: `${det.name} necessarily includes ${impliedDef.name}`,
            confidence: 'medium',
          }),
        ],
      });
    }
  }

  const all = [...found.values()].sort(
    (a, b) =>
      categoryOrder(a.category) - categoryOrder(b.category) ||
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      a.name.localeCompare(b.name),
  );

  const detections = all.filter((d) => d.confidence !== 'low');
  const tentative = all.filter((d) => d.confidence === 'low');

  const byCategory = {} as Record<TechnologyCategoryId, number>;
  for (const d of detections) {
    byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
  }

  return {
    detections,
    tentative,
    stats: {
      detected: detections.length,
      tentative: tentative.length,
      byCategory,
      signalsEvaluated,
    },
  };
}
