import type { PerformanceProvider } from "../types.js";

/**
 * Re-exported for convenience so provider implementations can do
 * `import type { PerformanceProvider } from "./performanceProvider.js"`
 * without reaching into ../types.js directly. The interface itself
 * lives in types.js alongside the other shared contracts.
 */
export type { PerformanceProvider, PerformanceProviderResult, CoreWebVitalsEvidence } from "../types.js";

/**
 * A provider that always reports itself unavailable. Used as the
 * default when no real provider is configured/injected, so calling
 * code never has to null-check "is there a provider at all" - only
 * "what status did it come back with".
 */
export const unavailableProvider: PerformanceProvider = {
  name: "none",
  async analyze() {
    return {
      status: "unavailable" as const,
      evidence: null,
      errorMessage: "No performance provider configured",
    };
  },
};
