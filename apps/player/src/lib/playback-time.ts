import type { WebBlackboxEvent } from "@webblackbox/protocol";

export type PlaybackTimeNormalization = {
  events: WebBlackboxEvent[];
  monoByEventId: Map<string, number>;
  rawMonoByEventId: Map<string, number>;
  source: "mono" | "wall-clock";
};

const SUSPICIOUS_TIMELINE_RATIO = 20;
const SUSPICIOUS_TIMELINE_ABSOLUTE_GAP_MS = 60_000;

export function normalizePlaybackEvents(events: WebBlackboxEvent[]): PlaybackTimeNormalization {
  const rawMonoByEventId = new Map<string, number>();

  for (const event of events) {
    rawMonoByEventId.set(event.id, event.mono);
  }

  const shouldUseWallClock = shouldNormalizePlaybackToWallClock(events);
  const normalizedEvents = events
    .map((event) => {
      const normalizedMono = shouldUseWallClock && Number.isFinite(event.t) ? event.t : event.mono;

      return normalizedMono === event.mono
        ? event
        : {
            ...event,
            mono: normalizedMono
          };
    })
    .sort(
      (left, right) => left.mono - right.mono || left.t - right.t || left.id.localeCompare(right.id)
    );

  const monoByEventId = new Map<string, number>();

  for (const event of normalizedEvents) {
    monoByEventId.set(event.id, event.mono);
  }

  return {
    events: normalizedEvents,
    monoByEventId,
    rawMonoByEventId,
    source: shouldUseWallClock ? "wall-clock" : "mono"
  };
}

export function shouldNormalizePlaybackToWallClock(events: WebBlackboxEvent[]): boolean {
  if (events.length < 2) {
    return false;
  }

  const monoRange = readFiniteRange(events.map((event) => event.mono));
  const wallRange = readFiniteRange(events.map((event) => event.t));

  if (!monoRange || !wallRange) {
    return false;
  }

  const monoDuration = monoRange.max - monoRange.min;
  const wallDuration = wallRange.max - wallRange.min;

  if (wallDuration <= 0) {
    return false;
  }

  if (monoDuration <= 0) {
    return true;
  }

  const suspiciousGap = Math.max(
    wallDuration * SUSPICIOUS_TIMELINE_RATIO,
    wallDuration + SUSPICIOUS_TIMELINE_ABSOLUTE_GAP_MS
  );

  return monoDuration > suspiciousGap;
}

function readFiniteRange(values: number[]): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }

    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }

  return { min, max };
}
