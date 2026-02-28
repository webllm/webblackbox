export function toArrayBuffer(input: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy.buffer;
}
