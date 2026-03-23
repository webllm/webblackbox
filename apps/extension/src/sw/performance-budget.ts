import { extractNetworkResponseSummary } from "@webblackbox/protocol";

export function extractPerformanceBudgetNetworkSample(payload: unknown): {
  duration: number | null;
  failed: boolean;
} {
  const response = extractNetworkResponseSummary(payload);

  return {
    duration: response.duration,
    failed: response.failed
  };
}
