export function prefixValue(prefix: number[], index: number): number {
  if (index < 0) {
    return 0;
  }

  const value = prefix[index];
  return typeof value === "number" ? value : 0;
}

export function upperBoundByMono<T>(
  items: T[],
  mono: number,
  pickMono: (item: T) => number
): number {
  let low = 0;
  let high = items.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const item = items[mid];

    if (!item) {
      high = mid;
      continue;
    }

    if (pickMono(item) <= mono) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

export function lowerBoundByMono<T>(
  items: T[],
  mono: number,
  pickMono: (item: T) => number
): number {
  let low = 0;
  let high = items.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const item = items[mid];

    if (!item) {
      high = mid;
      continue;
    }

    if (pickMono(item) < mono) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}
