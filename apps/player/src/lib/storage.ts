export function readStoredNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);

    if (raw === null) {
      return null;
    }

    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function readStoredText(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);

    if (value === null) {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function writeStoredNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Ignore storage failures in restricted contexts (private mode, policy blocks).
  }
}

export function writeStoredText(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures in restricted contexts (private mode, policy blocks).
  }
}

export function removeStoredItem(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures in restricted contexts (private mode, policy blocks).
  }
}
