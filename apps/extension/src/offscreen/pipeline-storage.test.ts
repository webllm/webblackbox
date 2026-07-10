import "fake-indexeddb/auto";

import {
  EncryptedPipelineStorage,
  IndexedDbPipelineStorage,
  getOrCreateIndexedDbPipelineStorageKey,
  type StoredBlob,
  type StoredChunk
} from "@webblackbox/pipeline";
import type { SessionMetadata } from "@webblackbox/protocol";
import { describe, expect, it } from "vitest";

import {
  EXTENSION_PIPELINE_DATABASE,
  EXTENSION_PIPELINE_KEY_PURPOSE,
  EXTENSION_PIPELINE_KEYRING_DATABASE,
  LEGACY_PLAINTEXT_PIPELINE_DATABASE,
  getExtensionPipelineStorage
} from "./pipeline-storage.js";

const SESSION: SessionMetadata = {
  sid: "S-extension-at-rest-test",
  tabId: 1,
  startedAt: 1,
  mode: "full",
  url: "https://example.test/",
  tags: []
};

function createChunk(text: string): StoredChunk {
  const bytes = new TextEncoder().encode(text);

  return {
    sid: SESSION.sid,
    meta: {
      chunkId: "C-extension-at-rest",
      seq: 1,
      tStart: 1,
      tEnd: 1,
      monoStart: 1,
      monoEnd: 1,
      eventCount: 1,
      byteLength: bytes.byteLength,
      codec: "none",
      sha256: "a".repeat(64)
    },
    bytes
  };
}

function createBlob(text: string): StoredBlob {
  const bytes = new TextEncoder().encode(text);

  return {
    hash: "b".repeat(64),
    mime: "text/plain",
    size: bytes.byteLength,
    bytes,
    createdAt: 1,
    refCount: 1
  };
}

describe("extension offscreen pipeline storage", () => {
  it("purges legacy plaintext, encrypts payloads, and recovers the persisted key", async () => {
    const eventSecret = "EXTENSION_EVENT_SECRET";
    const blobSecret = "EXTENSION_BLOB_SECRET";
    const legacy = new IndexedDbPipelineStorage(LEGACY_PLAINTEXT_PIPELINE_DATABASE);
    await legacy.putSession(SESSION);
    await legacy.putChunk(createChunk("LEGACY_PLAINTEXT_EVENT"));

    const storage = await getExtensionPipelineStorage();
    await storage.putSession(SESSION);
    await storage.putChunk(createChunk(eventSecret));
    await storage.putBlob(createBlob(blobSecret), SESSION.sid);

    const legacyAfterPurge = new IndexedDbPipelineStorage(LEGACY_PLAINTEXT_PIPELINE_DATABASE);
    expect(await legacyAfterPurge.getSession(SESSION.sid)).toBeUndefined();

    const rawStorage = new IndexedDbPipelineStorage(EXTENSION_PIPELINE_DATABASE);
    const rawChunk = await rawStorage.getChunk(SESSION.sid, "C-extension-at-rest");
    const rawBlob = await rawStorage.getBlob("b".repeat(64));
    expect(new TextDecoder().decode(rawChunk?.bytes ?? new Uint8Array())).not.toContain(
      eventSecret
    );
    expect(new TextDecoder().decode(rawBlob?.bytes ?? new Uint8Array())).not.toContain(blobSecret);

    const recoveredKey = await getOrCreateIndexedDbPipelineStorageKey({
      databaseName: EXTENSION_PIPELINE_KEYRING_DATABASE,
      purpose: EXTENSION_PIPELINE_KEY_PURPOSE
    });
    const restartedStorage = new EncryptedPipelineStorage(
      new IndexedDbPipelineStorage(EXTENSION_PIPELINE_DATABASE),
      { key: recoveredKey.key }
    );

    expect(recoveredKey.created).toBe(false);
    await restartedStorage.assertReady();
    expect(
      new TextDecoder().decode(
        (await restartedStorage.getChunk(SESSION.sid, "C-extension-at-rest"))?.bytes ??
          new Uint8Array()
      )
    ).toBe(eventSecret);
    expect(
      new TextDecoder().decode(
        (await restartedStorage.getBlob("b".repeat(64)))?.bytes ?? new Uint8Array()
      )
    ).toBe(blobSecret);
  });
});
