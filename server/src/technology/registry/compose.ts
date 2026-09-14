import {
  TECHNOLOGY_REGISTRY as BASE_REGISTRY,
  type TechnologyDefinition,
  type DetectionRule,
} from '../technologyRegistry.js';
import { REGISTRY_OVERLAYS } from './overlays.js';
import { EXTENDED_TECHNOLOGIES } from './extended.js';
import type { TechnologyCategoryId, TechnologyMetadata } from '../types.js';

/** Composed entry: base definition plus optional relationship/metadata layer. */
export interface ComposedTechnology extends TechnologyDefinition {
  requires?: string[];
  excludes?: string[];
  requiresCategory?: TechnologyCategoryId[];
  metadata?: TechnologyMetadata;
  /** Additional rules evaluated by the forensic layer. */
  extendedRules: DetectionRule[];
  /** True when the entry originates from the V10 base registry. */
  isBase: boolean;
}

const BASE_SIGNAL_TYPES = new Set([
  'meta-generator', 'response-header', 'cookie-name', 'script-url',
  'stylesheet-url', 'resource-url', 'request-host', 'html-marker',
  'runtime-global', 'dom-attribute', 'class-fingerprint',
]);

function mergeUnique<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] | undefined {
  const values = [...(a ?? []), ...(b ?? [])];
  if (values.length === 0) return undefined;
  return [...new Set(values)];
}

function mergeRules(a: DetectionRule[], b: DetectionRule[]): DetectionRule[] {
  const out = [...a];
  const keys = new Set(a.map((r) => `${r.type}|${r.source}|${r.pattern.source}`));
  for (const rule of b) {
    const key = `${rule.type}|${rule.source}|${rule.pattern.source}`;
    if (!keys.has(key)) {
      keys.add(key);
      out.push(rule);
    }
  }
  return out;
}

function compose(): ComposedTechnology[] {
  const overlayBySlug = new Map(REGISTRY_OVERLAYS.map((o) => [o.slug, o]));
  const bySlug = new Map<string, ComposedTechnology>();

  for (const base of BASE_REGISTRY) {
    const ov = overlayBySlug.get(base.slug);
    bySlug.set(base.slug, {
      ...base,
      requires: ov?.requires,
      excludes: ov?.excludes,
      requiresCategory: ov?.requiresCategory,
      metadata: ov?.metadata,
      extendedRules: ov?.additionalRules ?? [],
      isBase: true,
    });
  }

  for (const ext of EXTENDED_TECHNOLOGIES) {
    const existing = bySlug.get(ext.slug);
    if (existing) {
      // A mature V10 registry may already contain a technology that this
      // expansion wants to enrich. Merge into the canonical entry instead of
      // creating duplicate graph nodes or bypassing dependency rules.
      bySlug.set(ext.slug, {
        ...existing,
        category: ext.category ?? existing.category,
        icon: ext.icon || existing.icon,
        homepage: ext.homepage || existing.homepage,
        rules: mergeRules(existing.rules, ext.rules),
        implies: mergeUnique(existing.implies, ext.implies),
        requires: mergeUnique(existing.requires, ext.requires),
        excludes: mergeUnique(existing.excludes, ext.excludes),
        requiresCategory: mergeUnique(existing.requiresCategory, ext.requiresCategory),
        metadata: ext.metadata ?? existing.metadata,
        extendedRules: mergeRules(existing.extendedRules, ext.rules),
        isBase: true,
      });
    } else {
      bySlug.set(ext.slug, {
        slug: ext.slug,
        name: ext.name,
        category: ext.category,
        icon: ext.icon,
        homepage: ext.homepage,
        rules: ext.rules,
        implies: ext.implies,
        requires: ext.requires,
        excludes: ext.excludes,
        requiresCategory: ext.requiresCategory,
        metadata: ext.metadata,
        extendedRules: ext.rules,
        isBase: false,
      });
    }
  }

  return [...bySlug.values()];
}

export const FULL_REGISTRY: readonly ComposedTechnology[] = compose();
export const FULL_REGISTRY_BY_SLUG: ReadonlyMap<string, ComposedTechnology> =
  new Map(FULL_REGISTRY.map((t) => [t.slug, t]));

/** True when a rule uses a signal type V10's base detector already handles. */
export const isBaseSignalType = (t: string): boolean => BASE_SIGNAL_TYPES.has(t);
