import { escapeHtml } from "./dom.js";

export function highlightJsonPreview(value: string): string {
  const escaped = escapeHtml(value);
  return escaped.replaceAll(/(&quot;[^&]*&quot;)(\s*:)/g, '<span class="json-key">$1</span>$2');
}

export function redactPreviewText(value: string): string {
  return value
    .replaceAll(
      /("?(?:password|passwd|token|secret|api[_-]?key|authorization|cookie)"?\s*[:=]\s*"?)[^",\s}]+("?)/gi,
      "$1***$2"
    )
    .replaceAll(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer ***")
    .replaceAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]");
}
