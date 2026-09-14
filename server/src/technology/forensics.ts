import type {
  TechnologyDetection, TechnologyEvidence, EvidenceRole, VersionEvidence,
  VersionConfidence, TechnologyRelationships, TechnologyAuditRelevance,
  TechnologyRisk, EvidenceBreakdown, TechnologyConfidence, TechnologyCategoryId,
} from './types.js';
import { FULL_REGISTRY, FULL_REGISTRY_BY_SLUG } from './registry/compose.js';

const VERSION_SHAPE = /^\d+(?:\.\d+){0,3}$/;
const RANK: Record<TechnologyConfidence, number> = { low: 1, medium: 2, high: 3 };

/* ── §3 Evidence roles ─────────────────────────────────────────────── */

/**
 * Direct  = the strongest independent observation(s) of the technology itself.
 * Corroborating = further independent signals that reinforce it.
 * Inferred = produced by a relationship, never counted as independent.
 */
export function assignEvidenceRoles(evidence: TechnologyEvidence[]): TechnologyEvidence[] {
  const strongest = evidence.reduce<number>(
    (max, e) => Math.max(max, RANK[e.confidence]), 0,
  );
  let directAssigned = false;

  return evidence.map((e) => {
    if (e.signalType === 'implied-by' || e.signalType === 'required-by') {
      return { ...e, role: 'inferred' as EvidenceRole };
    }
    if (!directAssigned && RANK[e.confidence] === strongest) {
      directAssigned = true;
      return { ...e, role: 'direct' as EvidenceRole };
    }
    return {
      ...e,
      role: (RANK[e.confidence] === strongest ? 'direct' : 'corroborating') as EvidenceRole,
    };
  });
}

export function evidenceBreakdown(evidence: TechnologyEvidence[]): EvidenceBreakdown {
  const b: EvidenceBreakdown = { direct: 0, corroborating: 0, inferred: 0 };
  for (const e of evidence) b[e.role ?? 'direct'] += 1;
  return b;
}

/* ── §4 Deterministic explanation ──────────────────────────────────── */

const PHRASING: Partial<Record<TechnologyEvidence['signalType'], string>> = {
  'meta-generator': 'the generator meta tag',
  'response-header': 'response headers',
  'cookie-name': 'cookie names',
  'script-url': 'script URLs',
  'stylesheet-url': 'stylesheet URLs',
  'resource-url': 'resource paths',
  'request-host': 'request hosts',
  'html-marker': 'document markers',
  'runtime-global': 'runtime globals',
  'dom-attribute': 'DOM attributes',
  'class-fingerprint': 'a utility-class fingerprint',
  'dom-selector': 'DOM selectors',
  'js-property': 'JavaScript runtime properties',
  'css-rule': 'stylesheet rules',
  'robots-txt': 'robots.txt directives',
  'url-pattern': 'URL path patterns',
  'xhr-host': 'observed XHR destinations',
  'cert-issuer': 'the TLS certificate issuer',
  'inline-script': 'inline script contents',
  'probe': 'a bounded URL probe',
};

function joinList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Plain-English, template-driven. No AI, no randomness. */
export function explainDetection(d: TechnologyDetection): string {
  const independent = d.evidence.filter((e) => e.role !== 'inferred');

  if (independent.length === 0) {
    const via = d.evidence[0]?.source ?? 'a related technology';
    return `${d.name} was not directly observed. It was ${via}, which necessarily includes it.`;
  }

  const sources = [...new Set(independent.map((e) => e.source))].slice(0, 4);
  const surfaces = [...new Set(independent.map((e) => PHRASING[e.signalType] ?? 'observed signals'))];
  const versionNote = d.version
    ? ` The version ${d.version} was read from ${
        d.versionEvidence?.[0]?.source ?? 'an exposed signal'
      }.`
    : '';

  return `Detected from ${joinList(sources)} — ${independent.length} independent signal${
    independent.length === 1 ? '' : 's'
  } across ${joinList(surfaces)}.${versionNote}`;
}

/* ── §5 Version forensics ──────────────────────────────────────────── */

export function versionForensics(evidence: TechnologyEvidence[]): {
  version?: string;
  versionEvidence: VersionEvidence[];
  versionConfidence: VersionConfidence;
} {
  const versionEvidence: VersionEvidence[] = evidence
    .filter((e) => e.capturedVersion && VERSION_SHAPE.test(e.capturedVersion))
    .map((e) => ({
      version: e.capturedVersion!, source: e.source, signalType: e.signalType,
    }));

  if (versionEvidence.length === 0) {
    return { versionEvidence: [], versionConfidence: 'none' };
  }

  const distinct = [...new Set(versionEvidence.map((v) => v.version))]
    .sort((a, b) => b.length - a.length || a.localeCompare(b));

  if (distinct.length === 1) {
    return {
      version: distinct[0], versionEvidence,
      // Two independent sources agreeing is stronger than one.
      versionConfidence: versionEvidence.length >= 2 ? 'high' : 'medium',
    };
  }

  // Prefix-compatible ("10" + "10.2.1") collapses to the most specific.
  const longest = distinct[0];
  if (distinct.every((v) => v === longest || longest.startsWith(`${v}.`))) {
    return { version: longest, versionEvidence, versionConfidence: 'high' };
  }

  // Genuine conflict: report nothing rather than pick a winner.
  return { versionEvidence, versionConfidence: 'conflicting' };
}

/* ── §6 Relationships ──────────────────────────────────────────────── */

export function buildRelationships(
  slug: string, detectedSlugs: Set<string>,
): TechnologyRelationships {
  const def = FULL_REGISTRY_BY_SLUG.get(slug);
  const present = (list?: string[]) => (list ?? []).filter((s) => detectedSlugs.has(s));

  const impliedBy: string[] = [];
  const requiredBy: string[] = [];
  for (const other of FULL_REGISTRY) {
    if (!detectedSlugs.has(other.slug)) continue;
    if ((other.implies ?? []).includes(slug)) impliedBy.push(other.slug);
    if ((other.requires ?? []).includes(slug)) requiredBy.push(other.slug);
  }

  return {
    implies: present(def?.implies).sort(),
    impliedBy: impliedBy.sort(),
    requires: present(def?.requires).sort(),
    requiredBy: requiredBy.sort(),
    excludes: present(def?.excludes).sort(),
  };
}

/* ── §10/§11 Audit bridge and risk ─────────────────────────────────── */

/** Signal types that mean the version is publicly readable without auth. */
const PUBLIC_VERSION_SURFACES = new Set([
  'meta-generator', 'response-header', 'html-marker', 'script-url', 'stylesheet-url',
]);

export function technologyRisk(d: TechnologyDetection): TechnologyRisk {
  const exposed = (d.versionEvidence ?? []).some((v) =>
    PUBLIC_VERSION_SURFACES.has(v.signalType),
  );
  return {
    versionKnown: Boolean(d.version),
    // Stays 'unknown' by design: V10 has no authoritative lifecycle source,
    // so "outdated" would be a guess. Promote only when one is wired in.
    outdatedRisk: 'unknown',
    exposedVersion: exposed,
  };
}

const THIRD_PARTY_SURFACES = new Set(['request-host', 'xhr-host', 'script-url']);

/**
 * Populated ONLY from conditions already provable from the evidence.
 * No generic "X may affect performance" statements.
 */
export function auditRelevance(d: TechnologyDetection): TechnologyAuditRelevance | undefined {
  const categories: string[] = [];
  const reasons: string[] = [];
  const refs: number[] = [];

  if (d.technologyRisk?.exposedVersion && d.version) {
    const idx = d.evidence.findIndex(
      (e) => e.capturedVersion === d.version && PUBLIC_VERSION_SURFACES.has(e.signalType),
    );
    categories.push('security');
    reasons.push(`version ${d.version} is publicly exposed in ${d.evidence[idx]?.source ?? 'a public signal'}`);
    if (idx >= 0) refs.push(idx);
  }

  if (d.category === 'payments' || d.category === 'ecommerce') {
    categories.push('ecommerce');
    reasons.push('cart or payment technology detected on the page');
  }

  const thirdParty = d.evidence
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => THIRD_PARTY_SURFACES.has(e.signalType) && e.role !== 'inferred');
  if (thirdParty.length > 0 && ['analytics', 'marketing', 'media', 'consent'].includes(d.category)) {
    categories.push('performance');
    reasons.push(`${thirdParty.length} third-party network request signal${
      thirdParty.length === 1 ? '' : 's'} observed`);
    refs.push(...thirdParty.map((t) => t.i));
  }

  if (categories.length === 0) return undefined;
  return {
    categories: [...new Set(categories)].sort(),
    reason: reasons.join('; '),
    evidenceRefs: [...new Set(refs)].sort((a, b) => a - b),
  };
}
