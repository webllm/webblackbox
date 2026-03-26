import { createPlayerI18n, type PlayerLocale } from "./i18n.js";

export function describeScreenshotMeta(
  marker: {
    x: number;
    y: number;
    viewportWidth?: number;
    viewportHeight?: number;
    reason?: string;
  } | null,
  trail: Array<{ x: number; y: number; mono: number; click: boolean }>,
  locale: PlayerLocale = "en"
): string {
  const i18n = createPlayerI18n(locale);
  const markerText = describeScreenshotMarker(marker, locale);
  const trailText =
    trail.length > 0
      ? i18n.t("screenshotTrailPoints", { count: trail.length })
      : i18n.messages.screenshotNoTrailPoints;
  return `${markerText} | ${trailText}`;
}

export function describeScreenshotMarker(
  marker: {
    x: number;
    y: number;
    viewportWidth?: number;
    viewportHeight?: number;
    reason?: string;
  } | null,
  locale: PlayerLocale = "en"
): string {
  const i18n = createPlayerI18n(locale);

  if (!marker) {
    return i18n.messages.screenshotNoPointerMarker;
  }

  const base = i18n.t("screenshotPointerMarker", {
    x: Math.round(marker.x),
    y: Math.round(marker.y)
  });
  return marker.reason ? `${base} [${marker.reason}]` : base;
}
