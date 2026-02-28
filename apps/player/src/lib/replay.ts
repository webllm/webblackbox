const REPLAY_HEADER_BLOCKLIST = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "referer"
]);

export function createReplayHeaders(headers: Record<string, string>): Headers {
  const replayHeaders = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    const normalizedValue = String(value ?? "").trim();

    if (
      normalizedValue.length === 0 ||
      REPLAY_HEADER_BLOCKLIST.has(normalizedName) ||
      normalizedName.startsWith("sec-")
    ) {
      continue;
    }

    if (normalizedValue === "[REDACTED]") {
      continue;
    }

    replayHeaders.set(name, normalizedValue);
  }

  return replayHeaders;
}

export function shouldAttachReplayBody(method: string, bodyText: string | undefined): boolean {
  if (typeof bodyText !== "string") {
    return false;
  }

  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}
