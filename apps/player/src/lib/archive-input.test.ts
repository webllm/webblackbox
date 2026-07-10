import { describe, expect, it, vi } from "vitest";

import {
  ArchiveInputLimitError,
  readArchiveBlobBounded,
  readArchiveResponseBounded
} from "./archive-input.js";

describe("bounded Player archive input", () => {
  it("accepts an exact-size Blob and rejects an oversized Blob before arrayBuffer", async () => {
    const exactRead = vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer);
    await expect(readArchiveBlobBounded({ size: 4, arrayBuffer: exactRead }, 4)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
    expect(exactRead).toHaveBeenCalledOnce();

    const oversizedRead = vi.fn(async () => new Uint8Array(5).buffer);
    await expect(
      readArchiveBlobBounded({ size: 5, arrayBuffer: oversizedRead }, 4)
    ).rejects.toMatchObject({
      name: "ArchiveInputLimitError",
      actualBytes: 5,
      maxBytes: 4
    });
    expect(oversizedRead).not.toHaveBeenCalled();
  });

  it("streams an exact Content-Length boundary", async () => {
    const response = archiveResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])], "4");

    await expect(readArchiveResponseBounded(response, 4)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
  });

  it.each(["-1", "01", "1.5", "1, 1", "9007199254740992"])(
    "rejects invalid Content-Length %s",
    async (contentLength) => {
      const response = archiveResponse([new Uint8Array([1])], contentLength);
      await expect(readArchiveResponseBounded(response, 4)).rejects.toThrow(
        /invalid Content-Length/i
      );
    }
  );

  it("rejects an oversized Content-Length before reading", async () => {
    const getReader = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const body = { getReader, cancel } as unknown as ReadableStream<Uint8Array<ArrayBufferLike>>;
    const response = {
      headers: new Headers({ "content-length": "5" }),
      body
    };

    await expect(readArchiveResponseBounded(response, 4)).rejects.toMatchObject({
      name: "ArchiveInputLimitError",
      actualBytes: 5,
      maxBytes: 4
    });
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a forged short Content-Length stream that exceeds the hard limit", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array<ArrayBufferLike>>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
      },
      cancel() {
        canceled = true;
      }
    });
    const response = {
      headers: new Headers({ "content-length": "2" }),
      body
    };

    await expect(readArchiveResponseBounded(response, 4)).rejects.toMatchObject({
      name: "ArchiveInputLimitError",
      actualBytes: 5,
      maxBytes: 4
    });
    expect(canceled).toBe(true);
  });

  it("accepts a bounded stream without Content-Length and cancels it on overflow", async () => {
    await expect(
      readArchiveResponseBounded(
        archiveResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
        4
      )
    ).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));

    let canceled = false;
    const body = new ReadableStream<Uint8Array<ArrayBufferLike>>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
      },
      cancel() {
        canceled = true;
      }
    });
    await expect(
      readArchiveResponseBounded({ headers: new Headers(), body }, 4)
    ).rejects.toBeInstanceOf(ArchiveInputLimitError);
    expect(canceled).toBe(true);
  });

  it("fails closed for missing, truncated, and errored response bodies", async () => {
    await expect(
      readArchiveResponseBounded(
        {
          headers: new Headers({ "content-length": "0" }),
          body: null
        },
        4
      )
    ).rejects.toThrow(/no readable body/i);

    await expect(
      readArchiveResponseBounded(archiveResponse([new Uint8Array([1, 2])], "3"), 4)
    ).rejects.toThrow(/Content-Length mismatch/i);

    const errored = new ReadableStream<Uint8Array<ArrayBufferLike>>({
      start(controller) {
        controller.error(new Error("stream failed"));
      }
    });
    await expect(
      readArchiveResponseBounded({ headers: new Headers(), body: errored }, 4)
    ).rejects.toThrow("stream failed");
  });
});

function archiveResponse(
  chunks: Array<Uint8Array<ArrayBufferLike>>,
  contentLength?: string
): {
  headers: Headers;
  body: ReadableStream<Uint8Array<ArrayBufferLike>>;
} {
  return {
    headers: new Headers(contentLength === undefined ? {} : { "content-length": contentLength }),
    body: new ReadableStream<Uint8Array<ArrayBufferLike>>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      }
    })
  };
}
