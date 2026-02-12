import { createHash } from "node:crypto";

function toUint8Array(input: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }

  if (input instanceof Uint8Array) {
    return input;
  }

  return new Uint8Array(input);
}

export async function sha256Hex(input: ArrayBuffer | Uint8Array | string): Promise<string> {
  const data = toUint8Array(input);

  if (globalThis.crypto?.subtle) {
    const source = new Uint8Array(data.byteLength);
    source.set(data);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", source.buffer);
    return bufferToHex(new Uint8Array(digest));
  }

  return createHash("sha256").update(data).digest("hex");
}

function bufferToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
