export type LocalStorageSnapshotMode = "allow" | "lengths-only";

export const FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS = 300;

export function buildLocalStorageSnapshotExpression(mode: LocalStorageSnapshotMode): string {
  if (mode === "allow") {
    return `(() => {
  const count = localStorage.length;
  const maxItems = Math.min(count, ${FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS});
  const entries = [];
  for (let index = 0; index < maxItems; index += 1) {
    const key = localStorage.key(index);
    if (!key) {
      continue;
    }
    const value = localStorage.getItem(key) ?? "";
    entries.push([key, value.length]);
  }
  return JSON.stringify({ count, truncated: count > maxItems, entries });
})()`;
  }

  return `(() => {
  const count = localStorage.length;
  const maxItems = Math.min(count, ${FULL_MODE_STORAGE_SNAPSHOT_MAX_ITEMS});
  const lengths = [];
  for (let index = 0; index < maxItems; index += 1) {
    const key = localStorage.key(index);
    if (!key) {
      continue;
    }
    const value = localStorage.getItem(key) ?? "";
    lengths.push(value.length);
  }
  return JSON.stringify({ count, truncated: count > maxItems, lengths });
})()`;
}

export function parseStorageSnapshotMeta(
  serialized: string
): { count?: number; sampledCount?: number; truncated?: boolean } | null {
  try {
    const parsed = JSON.parse(serialized) as {
      count?: unknown;
      entries?: unknown;
      lengths?: unknown;
      truncated?: unknown;
    };
    const count = normalizeNonNegativeInt(parsed.count);
    const samples = Array.isArray(parsed.entries)
      ? parsed.entries
      : Array.isArray(parsed.lengths)
        ? parsed.lengths
        : [];

    return {
      count,
      sampledCount: samples.length,
      truncated: parsed.truncated === true
    };
  } catch {
    return null;
  }
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.floor(value);
}
