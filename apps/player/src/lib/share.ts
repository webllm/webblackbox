export type ShareArchiveRequest = {
  shareId: string;
  baseUrl: string;
  archiveUrl: string;
  queryApiKey?: string;
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
    const baseUrl = normalizeShareServerBaseUrl(fallbackBaseUrl);

    if (!baseUrl) {
      return null;
    }

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

  const baseUrl = safeShareServerOrigin(parsed);

  if (!baseUrl) {
    return null;
  }

  const queryApiKey = readQueryApiKey(parsed);

  if (queryApiKey === null) {
    return null;
  }

  const sharePageMatch = /^\/share\/([a-zA-Z0-9_-]+)$/.exec(parsed.pathname);

  if (sharePageMatch?.[1]) {
    const shareId = sharePageMatch[1];
    return {
      shareId,
      baseUrl,
      archiveUrl: `${baseUrl}/api/share/${encodeURIComponent(shareId)}/archive`,
      ...queryApiKey
    };
  }

  const archiveMatch = /^\/api\/share\/([a-zA-Z0-9_-]+)\/archive$/.exec(parsed.pathname);

  if (archiveMatch?.[1]) {
    return {
      shareId: archiveMatch[1],
      baseUrl,
      archiveUrl: `${baseUrl}${parsed.pathname}`,
      ...queryApiKey
    };
  }

  const metadataMatch = /^\/api\/share\/([a-zA-Z0-9_-]+)\/meta$/.exec(parsed.pathname);

  if (metadataMatch?.[1]) {
    const shareId = metadataMatch[1];
    return {
      shareId,
      baseUrl,
      archiveUrl: `${baseUrl}/api/share/${encodeURIComponent(shareId)}/archive`,
      ...queryApiKey
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
    return safeShareServerOrigin(url);
  } catch {
    return null;
  }
}

export function resolveShareServerOrigin(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = normalizeShareServerBaseUrl(value);

  if (!normalized) {
    return null;
  }

  try {
    return new URL(normalized).origin;
  } catch {
    return null;
  }
}

function safeShareServerOrigin(url: URL): string | null {
  if (url.username.length > 0 || url.password.length > 0) {
    return null;
  }

  if (url.protocol === "https:") {
    return url.origin;
  }

  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    return url.origin;
  }

  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") {
    return true;
  }

  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function readQueryApiKey(url: URL): Pick<ShareArchiveRequest, "queryApiKey"> | null {
  const key = url.searchParams.get("key");
  if (!key) {
    return {};
  }

  const normalized = key.trim();

  if (
    normalized.length === 0 ||
    normalized.length > 4_096 ||
    containsAsciiControlCharacter(normalized)
  ) {
    return null;
  }

  return {
    queryApiKey: normalized
  };
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }

  return false;
}
