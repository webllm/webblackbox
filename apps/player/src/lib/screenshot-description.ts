export function describeScreenshotMeta(
  marker: {
    x: number;
    y: number;
    viewportWidth?: number;
    viewportHeight?: number;
    reason?: string;
  } | null,
  trail: Array<{ x: number; y: number; mono: number; click: boolean }>
): string {
  const markerText = describeScreenshotMarker(marker);
  const trailText = trail.length > 0 ? `Trail points: ${trail.length}` : "No trail points.";
  return `${markerText} | ${trailText}`;
}

export function describeScreenshotMarker(
  marker: {
    x: number;
    y: number;
    viewportWidth?: number;
    viewportHeight?: number;
    reason?: string;
  } | null
): string {
  if (!marker) {
    return "No pointer marker on this screenshot.";
  }

  const base = `Pointer marker: (${Math.round(marker.x)}, ${Math.round(marker.y)})`;
  return marker.reason ? `${base} [${marker.reason}]` : base;
}
