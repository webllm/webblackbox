export function compactText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function shortUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search}` || raw;
  } catch {
    return raw;
  }
}

export function truncateId(value: string): string {
  return value.length > 22 ? `${value.slice(0, 9)}...${value.slice(-8)}` : value;
}
