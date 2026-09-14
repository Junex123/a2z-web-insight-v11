import type {
  PageTechnologyResult, SiteTechnologyIntelligence, TechnologyCoverage,
  TechnologyVarianceObservation, TechnologyConfidence,
} from '../types.js';
import { categoryOrderExt } from '../registry/categoriesExtended.js';

/** §7 Deterministic site-wide aggregation. Pure; no I/O. */
export function aggregateSiteTechnology(
  pages: readonly PageTechnologyResult[],
): SiteTechnologyIntelligence {
  const totalPages = pages.length;
  const acc = new Map<string, {
    base: TechnologyCoverage;
    urls: string[];
    confidences: TechnologyConfidence[];
    versions: Set<string>;
  }>();

  let evidenceSignals = 0;

  for (const page of pages) {
    for (const d of page.intelligence.detections) {
      evidenceSignals += d.evidence.length;
      const existing = acc.get(d.slug);
      if (existing) {
        existing.urls.push(page.url);
        existing.confidences.push(d.confidence);
        if (d.version) existing.versions.add(d.version);
        existing.base.lastSeenUrl = page.url;
      } else {
        acc.set(d.slug, {
          urls: [page.url],
          confidences: [d.confidence],
          versions: new Set(d.version ? [d.version] : []),
          base: {
            slug: d.slug, name: d.name, category: d.category,
            icon: d.icon, homepage: d.homepage,
            pageCount: 0, totalPages, coveragePct: 0,
            firstSeenUrl: page.url, lastSeenUrl: page.url,
            confidenceStable: true, observedConfidences: [], versions: [],
          },
        });
      }
    }
  }

  const coverage: TechnologyCoverage[] = [...acc.values()].map((a) => ({
    ...a.base,
    pageCount: a.urls.length,
    coveragePct: totalPages === 0 ? 0 : Math.round((a.urls.length / totalPages) * 100),
    confidenceStable: new Set(a.confidences).size === 1,
    observedConfidences: [...new Set(a.confidences)].sort(),
    versions: [...a.versions].sort(),
  })).sort(
    (x, y) =>
      y.coveragePct - x.coveragePct ||
      categoryOrderExt(x.category) - categoryOrderExt(y.category) ||
      x.name.localeCompare(y.name),
  );

  return {
    totalPages,
    coverage,
    observations: detectVariance(pages, coverage),
    stats: {
      technologies: coverage.length,
      categoriesRepresented: new Set(coverage.map((c) => c.category)).size,
      evidenceSignals,
      averageCoveragePct: coverage.length === 0 ? 0
        : Math.round(coverage.reduce((n, c) => n + c.coveragePct, 0) / coverage.length),
    },
  };
}

/**
 * §8 Observations, not findings. Phrasing is deliberately neutral — a mixed
 * CDN footprint is often intentional (separate checkout infrastructure).
 */
function detectVariance(
  pages: readonly PageTechnologyResult[],
  coverage: readonly TechnologyCoverage[],
): TechnologyVarianceObservation[] {
  const out: TechnologyVarianceObservation[] = [];
  const urlsFor = (slug: string) =>
    pages.filter((p) => p.intelligence.detections.some((d) => d.slug === slug))
         .map((p) => p.url).sort();

  for (const cat of ['infrastructure', 'analytics'] as const) {
    const inCat = coverage.filter((c) => c.category === cat && c.coveragePct < 100);
    if (inCat.length < 2) continue;
    out.push({
      kind: cat === 'infrastructure' ? 'infrastructure-varies' : 'analytics-varies',
      summary:
        `${inCat.length} different ${cat} technologies were observed across the crawled ` +
        `pages, none present on all of them. This may be intentional (for example a ` +
        `separately hosted checkout) or may indicate inconsistent configuration.`,
      slugs: inCat.map((c) => c.slug).sort(),
      detail: inCat.map((c) => ({ slug: c.slug, urls: urlsFor(c.slug) })),
    });
  }

  for (const c of coverage) {
    if (c.pageCount === 1 && c.totalPages > 3) {
      out.push({
        kind: 'single-page-only',
        summary: `${c.name} was observed on only one of ${c.totalPages} crawled pages.`,
        slugs: [c.slug],
        detail: [{ slug: c.slug, urls: [c.firstSeenUrl] }],
      });
    } else if (c.coveragePct > 0 && c.coveragePct < 80 && c.pageCount > 1) {
      out.push({
        kind: 'partial-coverage',
        summary: `${c.name} was observed on ${c.pageCount} of ${c.totalPages} crawled pages (${c.coveragePct}%).`,
        slugs: [c.slug],
        detail: [{ slug: c.slug, urls: urlsFor(c.slug) }],
      });
    }
    if (c.versions.length > 1) {
      out.push({
        kind: 'version-varies',
        summary: `${c.name} exposed more than one version across pages: ${c.versions.join(', ')}.`,
        slugs: [c.slug],
        detail: [{ slug: c.slug, urls: urlsFor(c.slug) }],
      });
    }
  }

  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.slugs[0].localeCompare(b.slugs[0]));
}
