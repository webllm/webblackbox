import type { WebBlackboxEvent } from "@webblackbox/protocol";

import { asFiniteNumber, asRecord, asString } from "./parsing.js";

export function readScreenshotShotId(
  event: WebBlackboxEvent,
  data: Record<string, unknown> | null
): string | null {
  const direct =
    asString(data?.shotId) ??
    asString(data?.hash) ??
    asString(data?.contentHash) ??
    asString(data?.blobHash) ??
    asString(event.ref?.shot);

  if (!direct) {
    return null;
  }

  return normalizeBlobHashCandidate(direct);
}

export function normalizeBlobHashCandidate(value: string): string {
  const trimmed = value.trim();

  if (trimmed.startsWith("blobs/")) {
    return trimmed;
  }

  const prefixed = /^sha256-(.+)$/.exec(trimmed);
  return prefixed?.[1] ?? trimmed;
}

export function readScreenshotMarker(data: Record<string, unknown> | null): {
  x: number;
  y: number;
  viewportWidth?: number;
  viewportHeight?: number;
  reason?: string;
} | null {
  const pointer = asRecord(data?.pointer);

  if (!pointer) {
    return null;
  }

  const x = asFiniteNumber(pointer.x);
  const y = asFiniteNumber(pointer.y);

  if (x === null || y === null) {
    return null;
  }

  const viewport = asRecord(data?.viewport);
  const widthFromViewport = asFiniteNumber(viewport?.width);
  const heightFromViewport = asFiniteNumber(viewport?.height);
  const widthFromFallback = asFiniteNumber(data?.w);
  const heightFromFallback = asFiniteNumber(data?.h);

  return {
    x,
    y,
    viewportWidth: widthFromViewport ?? widthFromFallback ?? undefined,
    viewportHeight: heightFromViewport ?? heightFromFallback ?? undefined,
    reason: asString(data?.reason) ?? undefined
  };
}

export function readScreenshotContext(
  data: Record<string, unknown> | null,
  event: WebBlackboxEvent
): { mono: number | null; viewportWidth?: number; viewportHeight?: number } | null {
  const viewport = asRecord(data?.viewport);
  const widthFromViewport = asFiniteNumber(viewport?.width);
  const heightFromViewport = asFiniteNumber(viewport?.height);
  const widthFromFallback = asFiniteNumber(data?.w);
  const heightFromFallback = asFiniteNumber(data?.h);

  if (
    widthFromViewport === null &&
    heightFromViewport === null &&
    widthFromFallback === null &&
    heightFromFallback === null
  ) {
    return {
      mono: event.mono
    };
  }

  return {
    mono: event.mono,
    viewportWidth: widthFromViewport ?? widthFromFallback ?? undefined,
    viewportHeight: heightFromViewport ?? heightFromFallback ?? undefined
  };
}
