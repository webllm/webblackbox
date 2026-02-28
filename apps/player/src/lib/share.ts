export type ShareArchiveRequest = {
  shareId: string;
  baseUrl: string;
  archiveUrl: string;
};

export function resolveShareArchiveRequest(
  input: string,
  fallbackBaseUrl: string
): ShareArchiveRequest | null {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (/^[a-zA-Z0-9_-]{8,}$/.test(trimmed)) {
    const baseUrl = fallbackBaseUrl;
    return {
      shareId: trimmed,
      baseUrl,
      archiveUrl: `${baseUrl}/api/share/${encodeURIComponent(trimmed)}/archive`
    };
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const sharePageMatch = /^\/share\/([a-zA-Z0-9_-]+)$/.exec(parsed.pathname);

  if (sharePageMatch?.[1]) {
    const shareId = sharePageMatch[1];
    const baseUrl = parsed.origin;
    const keySuffix = buildAuthQuerySuffix(parsed);
    return {
      shareId,
      baseUrl,
      archiveUrl: `${baseUrl}/api/share/${encodeURIComponent(shareId)}/archive${keySuffix}`
    };
  }

  const archiveMatch = /^\/api\/share\/([a-zA-Z0-9_-]+)\/archive$/.exec(parsed.pathname);

  if (archiveMatch?.[1]) {
    return {
      shareId: archiveMatch[1],
      baseUrl: parsed.origin,
      archiveUrl: parsed.toString()
    };
  }

  const metadataMatch = /^\/api\/share\/([a-zA-Z0-9_-]+)\/meta$/.exec(parsed.pathname);

  if (metadataMatch?.[1]) {
    const shareId = metadataMatch[1];
    const keySuffix = buildAuthQuerySuffix(parsed);
    return {
      shareId,
      baseUrl: parsed.origin,
      archiveUrl: `${parsed.origin}/api/share/${encodeURIComponent(shareId)}/archive${keySuffix}`
    };
  }

  return null;
}

export function normalizeShareServerBaseUrl(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    return url.origin;
  } catch {
    return null;
  }
}

function buildAuthQuerySuffix(url: URL): string {
  const key = url.searchParams.get("key");
  if (!key) {
    return "";
  }

  return `?key=${encodeURIComponent(key)}`;
}
