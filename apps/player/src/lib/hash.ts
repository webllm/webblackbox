const HEX_PAD = "00";

export async function sha256HexFromText(value: string): Promise<string | null> {
  if (
    typeof globalThis.crypto === "undefined" ||
    !globalThis.crypto?.subtle ||
    typeof TextEncoder === "undefined"
  ) {
    return null;
  }

  try {
    const bytes = new TextEncoder().encode(value);
    return await sha256HexFromBytes(bytes);
  } catch {
    return null;
  }
}

export async function sha256HexFromBytes(value: BufferSource): Promise<string | null> {
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto?.subtle) {
    return null;
  }

  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", value);
    return toHex(new Uint8Array(digest));
  } catch {
    return null;
  }
}

function toHex(bytes: Uint8Array): string {
  let hex = "";

  for (const byte of bytes) {
    hex += (HEX_PAD + byte.toString(16)).slice(-2);
  }

  return hex;
}
