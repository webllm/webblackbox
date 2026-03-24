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
  const subtle = globalThis.crypto?.subtle;

  if (subtle) {
    const source = new Uint8Array(data.byteLength);
    source.set(data);
    const digest = await subtle.digest("SHA-256", source.buffer);
    return bufferToHex(new Uint8Array(digest));
  }

  const fromNode = await sha256HexWithNodeCrypto(data);

  if (fromNode) {
    return fromNode;
  }

  throw new Error("Web Crypto API or Node crypto is required for SHA-256 hashing.");
}

function bufferToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

let nodeCryptoPromise: Promise<typeof import("node:crypto") | null> | null = null;

async function sha256HexWithNodeCrypto(data: Uint8Array): Promise<string | null> {
  const runtime = globalThis as typeof globalThis & {
    process?: {
      versions?: {
        node?: string;
      };
    };
  };

  if (!runtime.process?.versions?.node) {
    return null;
  }

  nodeCryptoPromise ??= import("node:crypto").catch(() => null);
  const nodeCrypto = await nodeCryptoPromise;

  if (!nodeCrypto) {
    return null;
  }

  return nodeCrypto.createHash("sha256").update(data).digest("hex");
}
