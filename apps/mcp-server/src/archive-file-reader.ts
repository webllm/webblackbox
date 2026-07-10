import type { FileHandle } from "node:fs/promises";

/** Reads one already-open file descriptor without allocating beyond the observed size. */
export async function readFileHandleBounded(
  handle: FileHandle,
  expectedBytes: number,
  maxBytes: number
): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes) {
    throw new Error(`Archive input exceeds the MCP limit (${expectedBytes} > ${maxBytes} bytes).`);
  }

  const output = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;

  while (offset < expectedBytes) {
    const { bytesRead } = await handle.read(output, offset, expectedBytes - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }

  if (offset !== expectedBytes) {
    throw new Error(
      `Archive file size changed while being read (${offset} bytes read; expected ${expectedBytes}).`
    );
  }

  const probe = Buffer.allocUnsafe(1);
  const { bytesRead: trailingBytes } = await handle.read(probe, 0, 1, expectedBytes);
  const afterRead = await handle.stat();
  if (trailingBytes > 0 || afterRead.size !== expectedBytes) {
    const observedBytes = Math.max(expectedBytes + trailingBytes, afterRead.size);
    if (observedBytes > maxBytes) {
      throw new Error(
        `Archive input exceeds the MCP limit (${observedBytes} > ${maxBytes} bytes).`
      );
    }

    throw new Error(
      `Archive file size changed while being read (${observedBytes} bytes observed; expected ${expectedBytes}).`
    );
  }

  return output;
}
