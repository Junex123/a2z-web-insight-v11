import { detectTechnologies } from './technologyDetector.js'; // V10 base, UNCHANGED
import { FULL_REGISTRY, FULL_REGISTRY_BY_SLUG } from './registry/compose.js';
import { buildSurfaces, evaluateExtendedRule } from './detect/extendedSignals.js';
import { makeEvidence } from './technologyEvidence.js';
import { categoryOrderExt } from './registry/categoriesExtended.js';
import {
  assignEvidenceRoles, explainDetection, versionForensics, buildRelationships,
  technologyRisk, auditRelevance,
} from './forensics.js';
import type {
  TechnologyInput, TechnologyIntelligence, TechnologyDetection,
  TechnologyEvidence, TechnologyConfidence, TechnologyCategoryId,
} from './types.js';

const RANK: Record<TechnologyConfidence, number> = { low: 1, medium: 2, high: 3 };

/**
 * Forensic layer. The V10 base detector runs FIRST and unmodified; its
 * output is the floor. Everything here only adds evidence or relationships.
 */
export function analyzeTechnology(input: TechnologyInput): TechnologyIntelligence {
  // 1. Base pass — preserved exactly.
  const base = detectTechnologies(input);

  const byslug = new Map<string, TechnologyDetection>();
  for (const d of [...base.detections, ...base.tentative]) {
    byslug.set(d.slug, { ...d, evidence: [...d.evidence] });
  }

  // 2. Extended signal pass. Surfaces derived once (§20).
  const surfaces = buildSurfaces(input);
  let signalsEvaluated = base.stats.signalsEvaluated;

  for (const tech of FULL_REGISTRY) {
    const rules = tech.extendedRules;
    if (rules.length === 0) continue;
    signalsEvaluated += rules.length;

    const matches = rules
      .map((r) => evaluateExtendedRule(r, surfaces, input))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));
    if (matches.length === 0) continue;

    const existing = byslug.get(tech.slug);
    if (existing) {
      existing.category = tech.category;
      existing.icon = tech.icon;
      existing.homepage = tech.homepage;
      existing.name = tech.name;
      const seen = new Set(existing.evidence.map((e) => `${e.signalType}|${e.source}|${e.matched}`));
      for (const match of matches) {
        const key = `${match.evidence.signalType}|${match.evidence.source}|${match.evidence.matched}`;
        if (!seen.has(key)) {
          existing.evidence.push(match.evidence);
          seen.add(key);
        }
      }
    } else {
      byslug.set(tech.slug, {
        slug: tech.slug, name: tech.name, category: tech.category,
        icon: tech.icon, homepage: tech.homepage,
        confidence: 'low', implied: false,
        evidence: matches.map((m) => m.evidence),
      });
    }
  }

  // 3. Recompute confidence over the merged evidence set.
  for (const d of byslug.values()) d.confidence = resolveConfidence(d.evidence);

  // 4. Relationship resolution (deterministic, registry order).
  const suppressed: TechnologyDetection[] = [];
  applyRequires(byslug, suppressed);
  applyRequiresCategory(byslug, suppressed);
  applyExcludes(byslug, suppressed);
  applyImplies(byslug);

  // 5. Forensic enrichment.
  const detectedSlugs = new Set(byslug.keys());
  for (const d of byslug.values()) {
    d.evidence = assignEvidenceRoles(d.evidence);
    const vf = versionForensics(d.evidence);
    d.version = vf.version;
    d.versionEvidence = vf.versionEvidence;
    d.versionConfidence = vf.versionConfidence;
    d.relationships = buildRelationships(d.slug, detectedSlugs);
    d.metadata = FULL_REGISTRY_BY_SLUG.get(d.slug)?.metadata;
    d.technologyRisk = technologyRisk(d);
    d.auditRelevance = auditRelevance(d);
    d.explanation = explainDetection(d);
    for (const e of d.evidence) if (!e.observedOn) e.observedOn = input.url;
  }

  const all = [...byslug.values()].sort(
    (a, b) =>
      categoryOrderExt(a.category) - categoryOrderExt(b.category) ||
      RANK[b.confidence] - RANK[a.confidence] ||
      a.name.localeCompare(b.name),
  );

  const detections = all.filter((d) => d.confidence !== 'low');
  const tentative = all.filter((d) => d.confidence === 'low');
  const byCategory = {} as Record<TechnologyCategoryId, number>;
  for (const d of detections) byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;

  return {
    detections, tentative, suppressed,
    stats: {
      detected: detections.length,
      tentative: tentative.length,
      byCategory,
      signalsEvaluated,
      evidenceSignals: detections.reduce((n, d) => n + d.evidence.length, 0),
      categoriesRepresented: Object.keys(byCategory).length,
    },
  };
}

function resolveConfidence(evidence: TechnologyEvidence[]): TechnologyConfidence {
  const independent = evidence.filter(
    (e) => e.signalType !== 'implied-by' && e.signalType !== 'required-by',
  );
  let base: TechnologyConfidence = 'low';
  for (const e of independent) if (RANK[e.confidence] > RANK[base]) base = e.confidence;
  if (base === 'high') return 'high';

  const corroborating = independent.filter((e) => RANK[e.confidence] >= 2);
  const types = new Set(corroborating.map((e) => e.signalType));
  const values = new Set(corroborating.map((e) => e.matched));
  if (types.size >= 2 && values.size >= 2) return 'high';

  // Inferred-only detections cap at medium and never reach high.
  return independent.length === 0 ? 'medium' : base;
}

/** §2 requires: a dependent technology cannot stand without its base. */
function applyRequires(
  map: Map<string, TechnologyDetection>, suppressed: TechnologyDetection[],
) {
  let changed = true;
  while (changed) { // transitive: removing A may invalidate B that requires A
    changed = false;
    for (const tech of FULL_REGISTRY) {
      const d = map.get(tech.slug);
      if (!d || !tech.requires?.length) continue;
      const missing = tech.requires.filter((r) => !map.has(r));
      if (missing.length === 0) continue;
      map.delete(tech.slug);
      suppressed.push({ ...d, unmetDependency: `requires ${missing.join(', ')}` });
      changed = true;
    }
  }
}

function applyRequiresCategory(
  map: Map<string, TechnologyDetection>, suppressed: TechnologyDetection[],
) {
  const present = new Set([...map.values()].map((d) => d.category));
  for (const tech of FULL_REGISTRY) {
    const d = map.get(tech.slug);
    if (!d || !tech.requiresCategory?.length) continue;
    if (tech.requiresCategory.some((c) => present.has(c))) continue;
    map.delete(tech.slug);
    suppressed.push({
      ...d, unmetDependency: `requiresCategory ${tech.requiresCategory.join(' | ')}`,
    });
  }
}

/** §2 excludes: the stronger detection wins; ties keep both (no guessing). */
function applyExcludes(
  map: Map<string, TechnologyDetection>, suppressed: TechnologyDetection[],
) {
  for (const tech of FULL_REGISTRY) {
    const a = map.get(tech.slug);
    if (!a || !tech.excludes?.length) continue;
    for (const otherSlug of tech.excludes) {
      const b = map.get(otherSlug);
      if (!b) continue;
      if (RANK[a.confidence] > RANK[b.confidence]) {
        map.delete(otherSlug);
        suppressed.push({ ...b, suppressedBy: a.slug });
      }
      // Equal confidence: both retained. Reporting a genuine ambiguity beats
      // silently picking one platform over another.
    }
  }
}

function applyImplies(map: Map<string, TechnologyDetection>) {
  for (const tech of FULL_REGISTRY) {
    const d = map.get(tech.slug);
    if (!d || d.implied || RANK[d.confidence] < 2) continue;
    for (const slug of tech.implies ?? []) {
      if (map.has(slug)) continue;
      const def = FULL_REGISTRY_BY_SLUG.get(slug);
      if (!def) continue;
      map.set(slug, {
        slug: def.slug, name: def.name, category: def.category,
        icon: def.icon, homepage: def.homepage,
        confidence: 'medium', implied: true,
        evidence: [makeEvidence({
          signalType: 'implied-by', source: `implied by ${d.name}`,
          matched: `${d.name} necessarily includes ${def.name}`, confidence: 'medium',
        })],
      });
    }
  }
}
