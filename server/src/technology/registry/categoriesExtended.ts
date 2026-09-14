import type { TechnologyCategoryId } from '../types.js';
import { TECHNOLOGY_CATEGORIES as BASE } from '../technologyCategories.js';

export interface TechnologyCategory {
  id: TechnologyCategoryId;
  label: string;
  order: number;
}

/** Appended only. Base orders (10–99) are untouched; 'other' stays last. */
const ADDITIONAL: readonly TechnologyCategory[] = [
  { id: 'marketing', label: 'Marketing & CRM',       order: 55 },
  { id: 'consent',   label: 'Consent & Privacy',     order: 58 },
  { id: 'security',  label: 'Security',              order: 62 },
  { id: 'search',    label: 'Site Search',           order: 65 },
  { id: 'forms',     label: 'Forms',                 order: 68 },
  { id: 'media',     label: 'Video & Media',         order: 70 },
  { id: 'fonts',     label: 'Fonts',                 order: 75 },
  { id: 'plugin',    label: 'Plugins & Extensions',  order: 80 },
] as const;

export const ALL_CATEGORIES: readonly TechnologyCategory[] = [
  ...BASE.filter((c) => c.id !== 'other'),
  ...ADDITIONAL,
  ...BASE.filter((c) => c.id === 'other'),
].sort((a, b) => a.order - b.order);

const BY_ID = new Map(ALL_CATEGORIES.map((c) => [c.id, c]));

export function categoryLabelExt(id: TechnologyCategoryId): string {
  return BY_ID.get(id)?.label ?? 'Other';
}
export function categoryOrderExt(id: TechnologyCategoryId): number {
  return BY_ID.get(id)?.order ?? 99;
}
