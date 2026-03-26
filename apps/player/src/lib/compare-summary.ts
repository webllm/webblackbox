import type { PlayerComparison } from "@webblackbox/player-sdk";

import { createPlayerI18n, type PlayerLocale } from "./i18n.js";

const MAX_TYPE_DELTAS = 8;
const MAX_ENDPOINT_DELTAS = 5;

export function formatCompareSummary(
  summary: PlayerComparison,
  locale: PlayerLocale = "en"
): string {
  const i18n = createPlayerI18n(locale);
  const lines = [
    locale === "zh-CN" ? "会话对比" : "Session Compare",
    `${locale === "zh-CN" ? "左侧" : "left"}: ${summary.leftSessionId}`,
    `${locale === "zh-CN" ? "右侧" : "right"}: ${summary.rightSessionId}`,
    "",
    locale === "zh-CN" ? "汇总" : "Totals",
    `- ${locale === "zh-CN" ? "事件" : "events"}: ${formatSignedCount(summary.eventDelta)}`,
    `- ${locale === "zh-CN" ? "错误" : "errors"}: ${formatSignedCount(summary.errorDelta)}`,
    `- ${locale === "zh-CN" ? "请求" : "requests"}: ${formatSignedCount(summary.requestDelta)}`,
    `- ${locale === "zh-CN" ? "时长" : "duration"}: ${formatSignedDuration(summary.durationDeltaMs)}`
  ];

  const topTypeDeltas = summary.typeDeltas.slice(0, MAX_TYPE_DELTAS);

  if (topTypeDeltas.length > 0) {
    lines.push("", locale === "zh-CN" ? "主要事件类型差异" : "Top Event Type Deltas");

    for (const delta of topTypeDeltas) {
      lines.push(
        `- ${formatSignedCount(delta.delta)} ${delta.type} (${locale === "zh-CN" ? "左侧" : "left"} ${delta.left} -> ${locale === "zh-CN" ? "右侧" : "right"} ${delta.right})`
      );
    }
  }

  const endpointDeltas = summary.endpointRegressions.slice(0, MAX_ENDPOINT_DELTAS);

  if (endpointDeltas.length > 0) {
    lines.push("", i18n.messages.compareHeadingEndpointRegressions);

    for (const endpoint of endpointDeltas) {
      lines.push(
        `- ${endpoint.method} ${endpoint.endpoint} | ${locale === "zh-CN" ? "次数" : "count"} ${formatSignedCount(endpoint.countDelta)} (${endpoint.leftCount}->${endpoint.rightCount}) | ${locale === "zh-CN" ? "失败率" : "fail-rate"} ${formatSignedPercent(endpoint.failureRateDelta)} | p95 ${formatSignedDuration(endpoint.p95DurationDeltaMs)}`
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
