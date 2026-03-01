export type PerformanceBudgetConfig = {
  lcpWarnMs: number;
  requestWarnMs: number;
  errorRateWarnPct: number;
  autoFreezeOnBreach: boolean;
};

export const DEFAULT_PERFORMANCE_BUDGET: PerformanceBudgetConfig = {
  lcpWarnMs: 2_500,
  requestWarnMs: 3_000,
  errorRateWarnPct: 35,
  autoFreezeOnBreach: false
};

const LCP_WARN_BOUNDS = {
  min: 500,
  max: 30_000
};

const REQUEST_WARN_BOUNDS = {
  min: 100,
  max: 60_000
};

const ERROR_RATE_BOUNDS = {
  min: 1,
  max: 100
};

export function normalizePerformanceBudget(input: unknown): PerformanceBudgetConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_PERFORMANCE_BUDGET };
  }

  const source = input as Record<string, unknown>;

  return {
    lcpWarnMs: normalizeBoundedNumber(
      source.lcpWarnMs,
      DEFAULT_PERFORMANCE_BUDGET.lcpWarnMs,
      LCP_WARN_BOUNDS.min,
      LCP_WARN_BOUNDS.max
    ),
    requestWarnMs: normalizeBoundedNumber(
      source.requestWarnMs,
      DEFAULT_PERFORMANCE_BUDGET.requestWarnMs,
      REQUEST_WARN_BOUNDS.min,
      REQUEST_WARN_BOUNDS.max
    ),
    errorRateWarnPct: normalizeBoundedNumber(
      source.errorRateWarnPct,
      DEFAULT_PERFORMANCE_BUDGET.errorRateWarnPct,
      ERROR_RATE_BOUNDS.min,
      ERROR_RATE_BOUNDS.max
    ),
    autoFreezeOnBreach:
      typeof source.autoFreezeOnBreach === "boolean"
        ? source.autoFreezeOnBreach
        : DEFAULT_PERFORMANCE_BUDGET.autoFreezeOnBreach
  };
}

function normalizeBoundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
}
