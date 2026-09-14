import { FULL_REGISTRY, FULL_REGISTRY_BY_SLUG } from '../registry/compose.js';
import { ALL_CATEGORIES } from '../registry/categoriesExtended.js';

export interface GraphIssue {
  slug: string;
  kind: 'unresolved' | 'self-reference' | 'cycle' | 'unknown-category' | 'mutual-exclude-conflict';
  detail: string;
}

/**
 * Validates the relationship graph. Run as a test, not at runtime —
 * a malformed registry is a build-time defect, not a user-facing one.
 */
export function validateRegistryGraph(): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const known = FULL_REGISTRY_BY_SLUG;
  const categoryIds = new Set(ALL_CATEGORIES.map((c) => c.id));

  for (const t of FULL_REGISTRY) {
    for (const [kind, list] of [
      ['implies', t.implies], ['requires', t.requires], ['excludes', t.excludes],
    ] as const) {
      for (const target of list ?? []) {
        if (target === t.slug) {
          issues.push({ slug: t.slug, kind: 'self-reference', detail: `${kind} itself` });
        } else if (!known.has(target)) {
          issues.push({ slug: t.slug, kind: 'unresolved', detail: `${kind} -> ${target}` });
        }
      }
    }
    for (const cat of t.requiresCategory ?? []) {
      if (!categoryIds.has(cat)) {
        issues.push({ slug: t.slug, kind: 'unknown-category', detail: `requiresCategory -> ${cat}` });
      }
    }
    // A technology cannot both require and exclude the same target.
    for (const r of t.requires ?? []) {
      if ((t.excludes ?? []).includes(r)) {
        issues.push({ slug: t.slug, kind: 'mutual-exclude-conflict', detail: `requires and excludes ${r}` });
      }
    }
  }

  issues.push(...findCycles('implies'), ...findCycles('requires'));
  return issues;
}

function findCycles(edge: 'implies' | 'requires'): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>(FULL_REGISTRY.map((t) => [t.slug, WHITE]));
  const stack: string[] = [];

  const visit = (slug: string) => {
    colour.set(slug, GREY);
    stack.push(slug);
    for (const next of FULL_REGISTRY_BY_SLUG.get(slug)?.[edge] ?? []) {
      if (!FULL_REGISTRY_BY_SLUG.has(next)) continue; // reported separately
      const c = colour.get(next);
      if (c === GREY) {
        const from = stack.indexOf(next);
        issues.push({
          slug, kind: 'cycle',
          detail: `${edge} cycle: ${[...stack.slice(from), next].join(' -> ')}`,
        });
      } else if (c === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    colour.set(slug, BLACK);
  };

  for (const t of FULL_REGISTRY) if (colour.get(t.slug) === WHITE) visit(t.slug);
  return issues;
}
