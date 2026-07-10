import {
  EncryptedPipelineStorage,
  IndexedDbPipelineStorage,
  deleteIndexedDbDatabase,
  getOrCreateIndexedDbPipelineStorageKey,
  type PipelineStorage
} from "@webblackbox/pipeline";

export const EXTENSION_PIPELINE_DATABASE = "webblackbox-flight-recorder-encrypted-v1";
export const EXTENSION_PIPELINE_KEYRING_DATABASE = "webblackbox-flight-recorder-keyring-v1";
export const LEGACY_PLAINTEXT_PIPELINE_DATABASE = "webblackbox-flight-recorder";
export const EXTENSION_PIPELINE_KEY_PURPOSE = "webblackbox-extension:pipeline-payload:aes-gcm:v1";

let storagePromise: Promise<PipelineStorage> | null = null;

/**
 * Returns the shared encrypted storage used by all offscreen pipelines.
 *
 * The non-extractable key survives offscreen/service-worker restarts in a
 * purpose-specific IndexedDB keyring. If that key is newly created, any data
 * database that may contain legacy plaintext or payloads encrypted with a lost
 * key is purged before it is opened.
 */
export function getExtensionPipelineStorage(): Promise<PipelineStorage> {
  storagePromise ??= initializeExtensionPipelineStorage();
  return storagePromise;
}

async function initializeExtensionPipelineStorage(): Promise<PipelineStorage> {
  await deleteIndexedDbDatabase(LEGACY_PLAINTEXT_PIPELINE_DATABASE);

  const managedKey = await getOrCreateIndexedDbPipelineStorageKey({
    databaseName: EXTENSION_PIPELINE_KEYRING_DATABASE,
    purpose: EXTENSION_PIPELINE_KEY_PURPOSE
  });

  if (managedKey.created) {
    await deleteIndexedDbDatabase(EXTENSION_PIPELINE_DATABASE);
  }

  const storage = new EncryptedPipelineStorage(
    new IndexedDbPipelineStorage(EXTENSION_PIPELINE_DATABASE),
    {
      key: managedKey.key
    }
  );
  await storage.assertReady();
  return storage;
}
