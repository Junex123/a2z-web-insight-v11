import type { Category, CategoryScore, Issue, Severity } from "../types.js";

/**
 * Points deducted from a 100-point category baseline per issue severity.
 * Exported so any code that needs to explain "which measurement caused
 * how much score impact" (e.g. the Core Web Vitals factor breakdown)
 * reads from this single source of truth instead of duplicating numbers.
 */
export const DEDUCTION: Record<Severity, number> = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3,
};

const CATEGORIES: Category[] = ["performance", "seo", "security", "accessibility", "ux", "responsiveness"];

export function scoreCategory(category: Category, issues: Issue[]): CategoryScore {
  const inCategory = issues.filter((i) => i.category === category);
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  let deduction = 0;
  for (const issue of inCategory) {
    counts[issue.severity]++;
    deduction += DEDUCTION[issue.severity];
  }
  const score = Math.max(0, Math.min(100, 100 - deduction));
  return { category, score, issueCount: counts };
}

export function scoreAll(issues: Issue[]): {
  categoryScores: CategoryScore[];
  overall: number;
} {
  const categoryScores = CATEGORIES.map((c) => scoreCategory(c, issues));
  const overall = Math.round(
    categoryScores.reduce((sum, c) => sum + c.score, 0) / categoryScores.length,
  );
  return { categoryScores, overall };
}

/**
 * Ranks issues for the "fix these first" view: severity first, then
 * (for ties) performance/security ahead of lower-traceability SEO nits.
 * This is a deterministic sort, not an AI judgment call.
 */
export function prioritize(issues: Issue[], limit = 5): Issue[] {
  const categoryTiebreak: Record<Category, number> = { security: 5, accessibility: 4, performance: 3, ux: 2, responsiveness: 1, seo: 0 };
  return [...issues]
    .sort((a, b) => {
      if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
      return categoryTiebreak[b.category] - categoryTiebreak[a.category];
    })
    .slice(0, limit);
}
