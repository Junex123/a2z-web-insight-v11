/* PRESERVED: existing exports unchanged so current V10 imports keep working. */
export { detectTechnologies } from './technologyDetector.js';
export { TECHNOLOGY_REGISTRY, REGISTRY_BY_SLUG } from './technologyRegistry.js';
export {
  TECHNOLOGY_CATEGORIES, categoryLabel, categoryOrder, groupByCategory,
  type TechnologyGroup,
} from './technologyCategories.js';

/* NEW */
export { analyzeTechnology } from './technologyIntelligence.js';
export { FULL_REGISTRY, FULL_REGISTRY_BY_SLUG } from './registry/compose.js';
export { ALL_CATEGORIES, categoryLabelExt, categoryOrderExt } from './registry/categoriesExtended.js';
export { validateRegistryGraph, type GraphIssue } from './graph/validate.js';
export { requestManifest } from './detect/extendedSignals.js';
export { aggregateSiteTechnology } from './site/coverage.js';
export {
  explainDetection, versionForensics, evidenceBreakdown, assignEvidenceRoles,
} from './forensics.js';
export type * from './types.js';
