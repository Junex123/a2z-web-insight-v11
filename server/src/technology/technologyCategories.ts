import type { TechnologyCategoryId, TechnologyDetection } from './types.js';

export interface TechnologyCategory {
  id: TechnologyCategoryId;
  label: string;
  order: number;
}

export const TECHNOLOGY_CATEGORIES: readonly TechnologyCategory[] = [
  { id: 'cms',            label: 'CMS',                    order: 10 },
  { id: 'framework',      label: 'Frameworks & Libraries', order: 20 },
  { id: 'ecommerce',      label: 'Ecommerce',              order: 30 },
  { id: 'payments',       label: 'Payments',               order: 40 },
  { id: 'analytics',      label: 'Analytics',              order: 50 },
  { id: 'infrastructure', label: 'CDN / Infrastructure',   order: 60 },
  { id: 'other',          label: 'Other',                  order: 99 },
] as const;

const BY_ID = new Map(TECHNOLOGY_CATEGORIES.map((c) => [c.id, c]));

export function categoryLabel(id: TechnologyCategoryId): string {
  return BY_ID.get(id)?.label ?? 'Other';
}

export function categoryOrder(id: TechnologyCategoryId): number {
  return BY_ID.get(id)?.order ?? 99;
}

export interface TechnologyGroup {
  category: TechnologyCategory;
  items: TechnologyDetection[];
}

/**
 * Pure presentation grouping, extracted from the component so it is
 * testable without a DOM or a rendering harness. Empty categories are
 * omitted; order follows the category table.
 */
export function groupByCategory(
  detections: readonly TechnologyDetection[],
): TechnologyGroup[] {
  return TECHNOLOGY_CATEGORIES
    .map((category) => ({
      category,
      items: detections.filter((d) => d.category === category.id),
    }))
    .filter((g) => g.items.length > 0);
}
