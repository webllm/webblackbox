export type RequestMetaEntry = {
  url?: string;
  method?: string;
  startedAt?: number;
  mimeType?: string;
  status?: number;
  resourceType?: string;
  updatedAt: number;
};

export const REQUEST_META_TTL_MS = 5 * 60_000;
export const REQUEST_META_MAX_ENTRIES = 2_000;

export function buildRequestMetaKey(requestId: string, sessionId?: string): string {
  return sessionId ? `cdp:${sessionId}:${requestId}` : requestId;
}

export function upsertRequestMeta(
  entries: Map<string, RequestMetaEntry>,
  key: string,
  patch: Partial<Omit<RequestMetaEntry, "updatedAt">>,
  now = Date.now()
): void {
  pruneRequestMeta(entries, now);

  const next: RequestMetaEntry = {
    ...(entries.get(key) ?? { updatedAt: now }),
    updatedAt: now
  };

  applyDefinedPatch(next, patch);
  entries.set(key, next);
  trimRequestMeta(entries);
}

export function getRequestMeta(
  entries: Map<string, RequestMetaEntry>,
  key: string,
  now = Date.now()
): RequestMetaEntry | undefined {
  const entry = entries.get(key);

  if (!entry) {
    return undefined;
  }

  if (now - entry.updatedAt > REQUEST_META_TTL_MS) {
    entries.delete(key);
    return undefined;
  }

  return entry;
}

export function deleteRequestMeta(entries: Map<string, RequestMetaEntry>, key: string): void {
  entries.delete(key);
}

export function pruneRequestMeta(entries: Map<string, RequestMetaEntry>, now = Date.now()): void {
  for (const [key, entry] of entries) {
    if (now - entry.updatedAt > REQUEST_META_TTL_MS) {
      entries.delete(key);
    }
  }
}

function trimRequestMeta(entries: Map<string, RequestMetaEntry>): void {
  if (entries.size <= REQUEST_META_MAX_ENTRIES) {
    return;
  }

  const sorted = [...entries.entries()].sort(
    ([, left], [, right]) => left.updatedAt - right.updatedAt
  );
  const deleteCount = entries.size - REQUEST_META_MAX_ENTRIES;

  for (let index = 0; index < deleteCount; index += 1) {
    const [key] = sorted[index]!;
    entries.delete(key);
  }
}

function applyDefinedPatch(
  target: RequestMetaEntry,
  patch: Partial<Omit<RequestMetaEntry, "updatedAt">>
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      target[key as keyof Omit<RequestMetaEntry, "updatedAt">] = value as never;
    }
  }
}
