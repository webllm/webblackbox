import type { PlayerComparison } from "@webblackbox/player-sdk";

const MAX_TYPE_DELTAS = 8;
const MAX_ENDPOINT_DELTAS = 5;

export function formatCompareSummary(summary: PlayerComparison): string {
  const lines = [
    "Session Compare",
    `left: ${summary.leftSessionId}`,
    `right: ${summary.rightSessionId}`,
    "",
    "Totals",
    `- events: ${formatSignedCount(summary.eventDelta)}`,
    `- errors: ${formatSignedCount(summary.errorDelta)}`,
    `- requests: ${formatSignedCount(summary.requestDelta)}`,
    `- duration: ${formatSignedDuration(summary.durationDeltaMs)}`
  ];

  const topTypeDeltas = summary.typeDeltas.slice(0, MAX_TYPE_DELTAS);

  if (topTypeDeltas.length > 0) {
    lines.push("", "Top Event Type Deltas");

    for (const delta of topTypeDeltas) {
      lines.push(
        `- ${formatSignedCount(delta.delta)} ${delta.type} (left ${delta.left} -> right ${delta.right})`
      );
    }
  }

  const endpointDeltas = summary.endpointRegressions.slice(0, MAX_ENDPOINT_DELTAS);

  if (endpointDeltas.length > 0) {
    lines.push("", "Endpoint Regressions");

    for (const endpoint of endpointDeltas) {
      lines.push(
        `- ${endpoint.method} ${endpoint.endpoint} | count ${formatSignedCount(endpoint.countDelta)} (${endpoint.leftCount}->${endpoint.rightCount}) | fail-rate ${formatSignedPercent(endpoint.failureRateDelta)} | p95 ${formatSignedDuration(endpoint.p95DurationDeltaMs)}`
      );
    }
  }

  return lines.join("\n");
}

function formatSignedCount(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return "0";
  }

  return value > 0 ? `+${value}` : String(value);
}

function formatSignedPercent(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return "0.00%";
  }

  const scaled = value * 100;
  const fixed = Math.abs(scaled).toFixed(2);
  return scaled > 0 ? `+${fixed}%` : `-${fixed}%`;
}

function formatSignedDuration(valueMs: number): string {
  if (!Number.isFinite(valueMs) || valueMs === 0) {
    return "0ms";
  }

  const abs = Math.abs(valueMs);
  const display = abs >= 1000 ? `${(abs / 1000).toFixed(2)}s` : `${abs.toFixed(0)}ms`;
  return valueMs > 0 ? `+${display}` : `-${display}`;
}
