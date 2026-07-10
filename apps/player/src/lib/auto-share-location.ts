export type AutoShareLocationResolution = {
  reference: string | null;
  source: "fragment" | "query" | null;
  cleanedUrl: string | null;
};

/**
 * Resolves an auto-load share reference without mutating browser state.
 * Fragment references take precedence because fragments are not sent in HTTP requests.
 */
export function resolveAutoShareLocation(href: string): AutoShareLocationResolution {
  let url: URL;

  try {
    url = new URL(href);
  } catch {
    return {
      reference: null,
      source: null,
      cleanedUrl: null
    };
  }

  const fragmentParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : "");
  const fragmentReference = normalizeReference(fragmentParams.get("share"));
  const queryReference = normalizeReference(url.searchParams.get("share"));
  const reference = fragmentReference ?? queryReference;

  if (!reference) {
    return {
      reference: null,
      source: null,
      cleanedUrl: null
    };
  }

  const source = fragmentReference ? "fragment" : "query";
  url.searchParams.delete("share");

  if (fragmentReference) {
    fragmentParams.delete("share");
    const remainingFragment = fragmentParams.toString();
    url.hash = remainingFragment ? `#${remainingFragment}` : "";
  }

  return {
    reference,
    source,
    cleanedUrl: url.href
  };
}

/** Scrubs the consumed reference synchronously before the caller can start asynchronous loading. */
export function consumeAutoShareLocation(
  href: string,
  replaceState: (cleanedUrl: string) => void
): string | null {
  const resolution = resolveAutoShareLocation(href);

  if (!resolution.reference || !resolution.cleanedUrl) {
    return null;
  }

  replaceState(resolution.cleanedUrl);
  return resolution.reference;
}

function normalizeReference(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
