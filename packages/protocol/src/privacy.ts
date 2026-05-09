const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const UUID_SEGMENT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_SEGMENT_PATTERN = /^[0-9a-f]{8,}$/i;
const BASE64URL_SEGMENT_PATTERN = /^[a-z\d_-]{16,}$/i;
const EMAIL_LIKE_PATTERN = /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/;
const SECRET_PREFIX_SEGMENT_PATTERN =
  /^(?:sk|pk)_(?:live|test)_[a-z\d_-]{8,}$|^gh[pousr]_[a-z\d_]{8,}$|^github_pat_[a-z\d_]{8,}$/i;

const SENSITIVE_SEGMENT_WORDS = [
  "token",
  "secret",
  "session",
  "jwt",
  "oauth",
  "code",
  "key",
  "reset",
  "invite"
];

/** Strips query/fragment data and route-templates likely identifiers in URL-like strings. */
export function sanitizeUrlForPrivacy(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return trimmed;
  }

  if (trimmed.startsWith("#")) {
    return "";
  }

  if (ABSOLUTE_URL_PATTERN.test(trimmed)) {
    return sanitizeAbsoluteUrl(trimmed);
  }

  return sanitizeRelativeUrl(trimmed);
}

/** Converts raw path segments into a privacy-preserving route template. */
export function routeTemplatePath(pathname: string): string {
  const hasLeadingSlash = pathname.startsWith("/");
  const hasTrailingSlash = pathname.length > 1 && pathname.endsWith("/");
  const segments = pathname.split("/").map((segment) => templatePathSegment(segment));
  let output = segments.join("/");

  if (hasLeadingSlash && !output.startsWith("/")) {
    output = `/${output}`;
  }

  if (hasTrailingSlash && !output.endsWith("/")) {
    output = `${output}/`;
  }

  return output || (hasLeadingSlash ? "/" : "");
}

function sanitizeAbsoluteUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return sanitizeRelativeUrl(value);
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    return `${url.origin}${routeTemplatePath(url.pathname)}`;
  }

  if (url.protocol === "about:") {
    return `${url.protocol}${routeTemplatePath(url.pathname)}`;
  }

  if (url.protocol === "chrome-extension:") {
    return `${url.protocol}${routeTemplatePath(url.pathname)}`;
  }

  if (url.protocol === "file:") {
    return `${url.protocol}[redacted]`;
  }

  return `${url.protocol}[redacted]`;
}

function sanitizeRelativeUrl(value: string): string {
  const hashIndex = value.indexOf("#");
  const withoutHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = withoutHash.indexOf("?");
  const withoutQuery = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;

  if (!withoutQuery) {
    return "";
  }

  return routeTemplatePath(withoutQuery);
}

function templatePathSegment(segment: string): string {
  if (!segment) {
    return segment;
  }

  const decoded = safeDecodeURIComponent(segment);
  const normalized = decoded.trim().toLowerCase();

  if (!normalized) {
    return segment;
  }

  if (/^\d+$/.test(normalized)) {
    return ":id";
  }

  if (EMAIL_LIKE_PATTERN.test(normalized)) {
    return ":id";
  }

  if (UUID_SEGMENT_PATTERN.test(normalized) || HEX_SEGMENT_PATTERN.test(normalized)) {
    return ":id";
  }

  if (SECRET_PREFIX_SEGMENT_PATTERN.test(normalized)) {
    return ":token";
  }

  if (SENSITIVE_SEGMENT_WORDS.some((word) => normalized !== word && normalized.includes(word))) {
    return ":token";
  }

  if (
    BASE64URL_SEGMENT_PATTERN.test(normalized) &&
    /[a-z]/i.test(normalized) &&
    /\d/.test(normalized)
  ) {
    return ":token";
  }

  if (normalized.length >= 6 && /[a-z]/i.test(normalized) && /\d/.test(normalized)) {
    return ":id";
  }

  return segment;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
