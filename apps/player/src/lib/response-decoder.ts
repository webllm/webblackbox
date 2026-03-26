import { createPlayerI18n, type PlayerLocale } from "./i18n.js";
import { compactText } from "./text.js";

export type ResponsePreview = {
  mime: string;
  sizeBytes: number;
  text: string;
  isJson: boolean;
};

export function decodeResponsePreview(
  mime: string,
  bytes: Uint8Array,
  maxPlainTextChars: number,
  locale: PlayerLocale = "en"
): ResponsePreview | null {
  const i18n = createPlayerI18n(locale);
  const normalizedMime = mime.toLowerCase();

  if (bytes.byteLength === 0) {
    return {
      mime: normalizedMime || "unknown",
      sizeBytes: 0,
      text: i18n.messages.responsePreviewEmptyBody,
      isJson: false
    };
  }

  const isTextual =
    normalizedMime.startsWith("text/") ||
    normalizedMime.includes("json") ||
    normalizedMime.includes("xml") ||
    normalizedMime.includes("javascript") ||
    normalizedMime.includes("form-urlencoded");

  if (!isTextual) {
    return {
      mime: normalizedMime || "unknown",
      sizeBytes: bytes.byteLength,
      text: i18n.formatBinaryResponsePreview(normalizedMime || "unknown", bytes.byteLength),
      isJson: false
    };
  }

  const slice = bytes.subarray(0, Math.min(bytes.byteLength, 12_000));
  const decoded = new TextDecoder().decode(slice).trim();

  if (!decoded) {
    return {
      mime: normalizedMime || "text/plain",
      sizeBytes: bytes.byteLength,
      text: i18n.messages.responsePreviewEmptyBody,
      isJson: false
    };
  }

  const maybeJson =
    normalizedMime.includes("json") || decoded.startsWith("{") || decoded.startsWith("[");

  if (maybeJson) {
    try {
      const parsed = JSON.parse(decoded) as unknown;
      const pretty = JSON.stringify(parsed, null, 2);
      return {
        mime: normalizedMime || "application/json",
        sizeBytes: bytes.byteLength,
        text: pretty,
        isJson: true
      };
    } catch {
      // Fallback to plain text.
    }
  }

  return {
    mime: normalizedMime || "text/plain",
    sizeBytes: bytes.byteLength,
    text: compactText(decoded, maxPlainTextChars),
    isJson: false
  };
}
