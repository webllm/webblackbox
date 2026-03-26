import type { NetworkWaterfallEntry } from "@webblackbox/player-sdk";

import { createPlayerI18n, type PlayerLocale } from "./i18n.js";
import { describeRequestName, resolveNetworkInitiator } from "./network-labels.js";
import { resolveNetworkSizeBytes } from "./network-size.js";

const NETWORK_DURATION_ALERT_MS = 3_000;

export type NetworkStatusFilter =
  | "all"
  | "success"
  | "redirect"
  | "client-error"
  | "server-error"
  | "failed";

export type NetworkTypeFilter =
  | "all"
  | "document"
  | "fetch"
  | "script"
  | "stylesheet"
  | "image"
  | "font"
  | "text"
  | "other";

export type NetworkSortKey =
  | "start"
  | "name"
  | "method"
  | "status"
  | "type"
  | "initiator"
  | "size"
  | "time";

export type NetworkSortDirection = "asc" | "desc";

export type NetworkViewFilters = {
  query: string;
  method: string;
  status: NetworkStatusFilter;
  type: NetworkTypeFilter;
};

export function applyNetworkViewFilters(
  entries: NetworkWaterfallEntry[],
  view: NetworkViewFilters,
  locale: PlayerLocale = "en"
): NetworkWaterfallEntry[] {
  const methodFilter = view.method.toUpperCase();
  const query = view.query.trim().toLowerCase();
  const statusFilter = view.status;
  const typeFilter = view.type;

  return entries.filter((entry) => {
    if (methodFilter !== "ALL" && entry.method.toUpperCase() !== methodFilter) {
      return false;
    }

    if (!matchesNetworkStatus(entry, statusFilter)) {
      return false;
    }

    if (!matchesNetworkType(entry, typeFilter)) {
      return false;
    }

    if (query.length === 0) {
      return true;
    }

    const requestName = describeRequestName(entry.url);
    const status = describeNetworkStatus(entry, locale);
    const type = resolveNetworkTypeLabel(entry.mimeType, locale);
    const initiator = resolveNetworkInitiator(entry, locale);
    const haystack =
      `${entry.reqId} ${entry.method} ${entry.url} ${requestName.name} ${requestName.host} ${status} ${type} ${initiator}`
        .trim()
        .toLowerCase();
    return haystack.includes(query);
  });
}

export function sortNetworkEntries(
  entries: NetworkWaterfallEntry[],
  sortKey: NetworkSortKey,
  sortDirection: NetworkSortDirection,
  locale: PlayerLocale = "en"
): NetworkWaterfallEntry[] {
  const direction = sortDirection === "asc" ? 1 : -1;

  return entries
    .map((entry, index) => ({
      entry,
      index
    }))
    .sort((left, right) => {
      const order = compareNetworkEntries(left.entry, right.entry, sortKey, locale) * direction;

      if (order !== 0) {
        return order;
      }

      return left.index - right.index;
    })
    .map((item) => item.entry);
}

export function compareNetworkEntries(
  left: NetworkWaterfallEntry,
  right: NetworkWaterfallEntry,
  sortKey: NetworkSortKey,
  locale: PlayerLocale = "en"
): number {
  if (sortKey === "start") {
    return left.startMono - right.startMono;
  }

  if (sortKey === "method") {
    return left.method.localeCompare(right.method);
  }

  if (sortKey === "status") {
    return networkStatusCode(left) - networkStatusCode(right);
  }

  if (sortKey === "type") {
    return resolveNetworkTypeLabel(left.mimeType, locale).localeCompare(
      resolveNetworkTypeLabel(right.mimeType, locale)
    );
  }

  if (sortKey === "initiator") {
    return resolveNetworkInitiator(left, locale).localeCompare(
      resolveNetworkInitiator(right, locale)
    );
  }

  if (sortKey === "size") {
    return resolveNetworkSizeBytes(left) - resolveNetworkSizeBytes(right);
  }

  if (sortKey === "time") {
    return left.durationMs - right.durationMs;
  }

  const leftName = describeRequestName(left.url);
  const rightName = describeRequestName(right.url);
  const byName = leftName.name.localeCompare(rightName.name);
  return byName !== 0 ? byName : leftName.host.localeCompare(rightName.host);
}

export function matchesNetworkStatus(
  entry: NetworkWaterfallEntry,
  filter: NetworkStatusFilter
): boolean {
  if (filter === "all") {
    return true;
  }

  if (filter === "failed") {
    return entry.failed;
  }

  const status = entry.status;

  if (typeof status !== "number") {
    return false;
  }

  if (filter === "success") {
    return status >= 200 && status < 300;
  }

  if (filter === "redirect") {
    return status >= 300 && status < 400;
  }

  if (filter === "client-error") {
    return status >= 400 && status < 500;
  }

  if (filter === "server-error") {
    return status >= 500;
  }

  return true;
}

export function matchesNetworkType(
  entry: NetworkWaterfallEntry,
  filter: NetworkTypeFilter
): boolean {
  if (filter === "all") {
    return true;
  }

  return resolveNetworkTypeBucket(entry.mimeType) === filter;
}

export function networkStatusCode(entry: NetworkWaterfallEntry): number {
  if (entry.failed) {
    return -1;
  }

  return typeof entry.status === "number" ? entry.status : 0;
}

export function describeNetworkStatus(
  entry: NetworkWaterfallEntry,
  locale: PlayerLocale = "en"
): string {
  const i18n = createPlayerI18n(locale);

  if (entry.failed) {
    return i18n.messages.networkStatusFailed;
  }

  if (typeof entry.status === "number") {
    if (entry.statusText && entry.statusText.length > 0) {
      return `${entry.status} ${entry.statusText}`;
    }

    return String(entry.status);
  }

  return i18n.messages.networkStatusPending;
}

export function resolveNetworkStatusClass(entry: NetworkWaterfallEntry): string {
  if (entry.failed) {
    return "wf-status-failed";
  }

  const status = entry.status;

  if (typeof status !== "number") {
    return "wf-status-neutral";
  }

  if (entry.durationMs >= NETWORK_DURATION_ALERT_MS) {
    return "wf-status-error";
  }

  if (status >= 500) {
    return "wf-status-error";
  }

  if (status >= 400) {
    return "wf-status-warn";
  }

  if (status >= 300) {
    return "wf-status-redirect";
  }

  if (status >= 200) {
    return "wf-status-ok";
  }

  return "wf-status-neutral";
}

export function resolveNetworkTypeLabel(
  mimeType: string | undefined,
  locale: PlayerLocale = "en"
): string {
  const i18n = createPlayerI18n(locale);
  const bucket = resolveNetworkTypeBucket(mimeType);
  return i18n.formatNetworkType(bucket === "all" ? "other" : bucket);
}

export function resolveNetworkTypeBucket(mimeType: string | undefined): NetworkTypeFilter {
  if (!mimeType) {
    return "other";
  }

  const mime = mimeType.toLowerCase();

  if (mime.includes("json") || mime.includes("xml") || mime.includes("protobuf")) {
    return "fetch";
  }

  if (mime.includes("javascript") || mime.includes("ecmascript")) {
    return "script";
  }

  if (mime.includes("css")) {
    return "stylesheet";
  }

  if (mime.startsWith("image/")) {
    return "image";
  }

  if (mime.startsWith("font/") || mime.includes("woff") || mime.includes("truetype")) {
    return "font";
  }

  if (mime.includes("html")) {
    return "document";
  }

  if (mime.startsWith("text/")) {
    return "text";
  }

  return "other";
}
