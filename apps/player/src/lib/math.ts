export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function readPointerRatio(event: PointerEvent, container: HTMLElement): number {
  const rect = container.getBoundingClientRect();

  if (rect.width <= 0) {
    return 0;
  }

  const offset = event.clientX - rect.left;
  return clamp(offset / rect.width, 0, 1);
}
