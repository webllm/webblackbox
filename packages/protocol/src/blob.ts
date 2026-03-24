function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function inferBlobFileExtension(mime: string): string {
  const normalized = normalize(mime);

  if (normalized.includes("png")) {
    return "png";
  }

  if (normalized.includes("webp")) {
    return "webp";
  }

  if (normalized.includes("json")) {
    return "json";
  }

  if (normalized.includes("html")) {
    return "html";
  }

  return "bin";
}

export function inferBlobMime(extension: string): string {
  switch (normalize(extension)) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "json":
      return "application/json";
    case "html":
      return "text/html";
    default:
      return "application/octet-stream";
  }
}
