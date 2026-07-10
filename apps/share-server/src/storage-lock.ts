import { randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { link, lstat, open, unlink, type FileHandle } from "node:fs/promises";

const LOCK_FILE_NAME = ".share-server.lock";
const LOCK_SCHEMA_VERSION = 1;
const MAX_LOCK_FILE_BYTES = 4 * 1024;
const MAX_ACQUIRE_ATTEMPTS = 8;
const LOCK_NONCE_PATTERN = /^[a-f0-9]{32}$/;

type ShareDataRootLockRecord = Readonly<{
  schemaVersion: 1;
  pid: number;
  nonce: string;
  hostname: string;
  createdAt: number;
  dataRoot: string;
  dataRootDevice: string;
  dataRootInode: string;
  ownerFile: string;
}>;

type InspectedShareDataRootLock = Readonly<{
  handle: FileHandle;
  stat: BigIntStats;
  record: ShareDataRootLockRecord;
  ownerPath: string;
}>;

export class ShareDataRootLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareDataRootLockedError";
  }
}

export class ShareDataRootLock {
  private released = false;

  constructor(
    private readonly dataRoot: string,
    private readonly dataRootIdentity: BigIntStats,
    private readonly lockPath: string,
    private readonly ownerPath: string,
    private readonly handle: FileHandle,
    private readonly lockIdentity: BigIntStats
  ) {}

  async release(): Promise<void> {
    if (this.released) {
      return;
    }

    let publicLockRemoved = false;
    try {
      await assertDataRootIdentity(this.dataRoot, this.dataRootIdentity);
      const currentHandleStat = await this.handle.stat({ bigint: true });
      assertSafePublishedLockStat(currentHandleStat);
      assertSameFileSystemObject(currentHandleStat, this.lockIdentity, this.lockPath);
      await assertLockLinkIdentity(this.lockPath, currentHandleStat);
      await assertLockLinkIdentity(this.ownerPath, currentHandleStat);
      await assertDataRootIdentity(this.dataRoot, this.dataRootIdentity);

      await unlink(this.lockPath);
      publicLockRemoved = true;

      await assertLockLinkIdentity(this.ownerPath, currentHandleStat);
      await unlink(this.ownerPath);
      await syncDirectoryBestEffort(this.dataRoot);
    } finally {
      if (publicLockRemoved) {
        this.released = true;
        await this.handle.close().catch(() => undefined);
      }
    }
  }
}

export async function acquireShareDataRootLock(
  dataRootPath: string,
  dataRootIdentity: BigIntStats
): Promise<ShareDataRootLock> {
  const dataRoot = resolve(dataRootPath);
  const lockPath = join(dataRoot, LOCK_FILE_NAME);
  await assertDataRootIdentity(dataRoot, dataRootIdentity);

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const published = await tryPublishLock(dataRoot, dataRootIdentity, lockPath);
    if (published) {
      return published;
    }

    const existing = await inspectPublishedLock(dataRoot, dataRootIdentity, lockPath);
    if (!existing) {
      continue;
    }

    try {
      assertLockRecordBoundToDataRoot(existing.record, dataRoot, dataRootIdentity);
      if (existing.record.hostname !== hostname()) {
        throw new ShareDataRootLockedError(
          `Share data directory "${dataRoot}" is locked by host "${existing.record.hostname}"; ` +
            "remote process liveness cannot be verified safely."
        );
      }
      if (isLocalProcessAlive(existing.record.pid)) {
        throw new ShareDataRootLockedError(
          `Share data directory "${dataRoot}" is already in use by a running ` +
            `share-server process (pid ${existing.record.pid}).`
        );
      }

      const recovered = await recoverStalePublishedLock(
        dataRoot,
        dataRootIdentity,
        lockPath,
        existing
      );
      if (!recovered) {
        continue;
      }
    } finally {
      await existing.handle.close().catch(() => undefined);
    }
  }

  throw new ShareDataRootLockedError(
    `Share data directory "${dataRoot}" lock changed repeatedly during startup.`
  );
}

async function tryPublishLock(
  dataRoot: string,
  dataRootIdentity: BigIntStats,
  lockPath: string
): Promise<ShareDataRootLock | null> {
  const nonce = randomUUID().replaceAll("-", "");
  const ownerFile = ownerFileName(process.pid, nonce);
  const ownerPath = join(dataRoot, ownerFile);
  const record: ShareDataRootLockRecord = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    pid: process.pid,
    nonce,
    hostname: hostname(),
    createdAt: Date.now(),
    dataRoot,
    dataRootDevice: dataRootIdentity.dev.toString(),
    dataRootInode: dataRootIdentity.ino.toString(),
    ownerFile
  };
  const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (payload.byteLength > MAX_LOCK_FILE_BYTES) {
    throw new Error("Share data directory lock metadata exceeds its safety limit.");
  }

  let handle: FileHandle | null = null;
  let ownerIdentity: BigIntStats | null = null;
  let published = false;
  try {
    await assertDataRootIdentity(dataRoot, dataRootIdentity);
    handle = await open(
      ownerPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600
    );
    await writeFileHandleFully(handle, payload);
    if (process.platform !== "win32") {
      await handle.chmod(0o600);
    }
    await handle.sync();
    ownerIdentity = await handle.stat({ bigint: true });
    assertSafeOwnerLockStat(ownerIdentity, payload.byteLength, ownerPath);
    await assertLockLinkIdentity(ownerPath, ownerIdentity);
    await assertDataRootIdentity(dataRoot, dataRootIdentity);

    try {
      await link(ownerPath, lockPath);
    } catch (error) {
      if (hasFileSystemErrorCode(error, "EEXIST")) {
        return null;
      }
      throw error;
    }

    published = true;
    const publishedStat = await handle.stat({ bigint: true });
    assertSafePublishedLockStat(publishedStat);
    assertSameFileSystemObject(publishedStat, ownerIdentity, lockPath);
    await assertLockLinkIdentity(ownerPath, publishedStat);
    await assertLockLinkIdentity(lockPath, publishedStat);
    await assertDataRootIdentity(dataRoot, dataRootIdentity);
    await syncDirectoryBestEffort(dataRoot);

    const result = new ShareDataRootLock(
      dataRoot,
      dataRootIdentity,
      lockPath,
      ownerPath,
      handle,
      publishedStat
    );
    handle = null;
    return result;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (!published && ownerIdentity) {
      await unlinkLockLinkIfUnchanged(dataRoot, dataRootIdentity, ownerPath, ownerIdentity);
    }
  }
}

async function inspectPublishedLock(
  dataRoot: string,
  dataRootIdentity: BigIntStats,
  lockPath: string
): Promise<InspectedShareDataRootLock | null> {
  await assertDataRootIdentity(dataRoot, dataRootIdentity);

  let pathStat: BigIntStats;
  try {
    pathStat = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (hasFileSystemErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }

  let handle: FileHandle | null = null;
  try {
    handle = await open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedStat = await handle.stat({ bigint: true });
    assertSafePublishedLockStat(openedStat);
    assertSameFileSystemObject(pathStat, openedStat, lockPath);
    const payload = await readFileHandleExactly(handle, Number(openedStat.size));
    const record = parseLockRecord(payload);
    const ownerPath = join(dataRoot, record.ownerFile);
    await assertLockLinkIdentity(lockPath, openedStat);
    await assertLockLinkIdentity(ownerPath, openedStat);
    await assertDataRootIdentity(dataRoot, dataRootIdentity);

    const result = {
      handle,
      stat: openedStat,
      record,
      ownerPath
    };
    handle = null;
    return result;
  } catch (error) {
    if (hasFileSystemErrorCode(error, "ENOENT")) {
      return null;
    }
    if (error instanceof ShareDataRootLockedError) {
      throw error;
    }
    throw unsafeLockError(lockPath, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function recoverStalePublishedLock(
  dataRoot: string,
  dataRootIdentity: BigIntStats,
  lockPath: string,
  existing: InspectedShareDataRootLock
): Promise<boolean> {
  const recoveryNonce = randomUUID().replaceAll("-", "");
  const recoveryPath = join(
    dataRoot,
    `.share-server.lock.recovery.${process.pid}.${recoveryNonce}`
  );
  let recoveryLinked = false;
  let publicLockRemoved = false;

  try {
    await assertLockLinkIdentity(lockPath, existing.stat);
    await assertLockLinkIdentity(existing.ownerPath, existing.stat);
    await assertDataRootIdentity(dataRoot, dataRootIdentity);
    try {
      await link(lockPath, recoveryPath);
      recoveryLinked = true;
    } catch (error) {
      if (hasFileSystemErrorCode(error, "ENOENT") || hasFileSystemErrorCode(error, "EEXIST")) {
        return false;
      }
      throw error;
    }

    const claimedStat = await existing.handle.stat({ bigint: true });
    if (
      !claimedStat.isFile() ||
      claimedStat.nlink !== 3n ||
      !hasMode(claimedStat, 0o600n) ||
      !isSameFileSystemObject(claimedStat, existing.stat)
    ) {
      return false;
    }

    await assertLockLinkIdentity(recoveryPath, claimedStat);
    await assertLockLinkIdentity(existing.ownerPath, claimedStat);
    await assertLockLinkIdentity(lockPath, claimedStat);
    if (isLocalProcessAlive(existing.record.pid)) {
      throw new ShareDataRootLockedError(
        `Share data directory "${dataRoot}" became owned by a running process during recovery.`
      );
    }
    await assertDataRootIdentity(dataRoot, dataRootIdentity);

    await unlink(lockPath);
    publicLockRemoved = true;
    await assertLockLinkIdentity(existing.ownerPath, claimedStat);
    await unlink(existing.ownerPath);
    await assertLockLinkIdentity(recoveryPath, claimedStat);
    await unlink(recoveryPath);
    recoveryLinked = false;
    await syncDirectoryBestEffort(dataRoot);
    return true;
  } finally {
    if (recoveryLinked) {
      await unlinkLockLinkIfUnchanged(dataRoot, dataRootIdentity, recoveryPath, existing.stat);
    }
    if (publicLockRemoved) {
      await syncDirectoryBestEffort(dataRoot);
    }
  }
}

function parseLockRecord(payload: Uint8Array): ShareDataRootLockRecord {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch (error) {
    throw new Error("Share data directory lock metadata is not valid UTF-8 JSON.", {
      cause: error
    });
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Share data directory lock metadata must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== LOCK_SCHEMA_VERSION ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.nonce !== "string" ||
    !LOCK_NONCE_PATTERN.test(record.nonce) ||
    typeof record.hostname !== "string" ||
    record.hostname.length === 0 ||
    record.hostname.length > 255 ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt as number) < 0 ||
    typeof record.dataRoot !== "string" ||
    typeof record.dataRootDevice !== "string" ||
    !/^\d+$/.test(record.dataRootDevice) ||
    typeof record.dataRootInode !== "string" ||
    !/^\d+$/.test(record.dataRootInode) ||
    typeof record.ownerFile !== "string" ||
    record.ownerFile !== ownerFileName(record.pid as number, record.nonce)
  ) {
    throw new Error("Share data directory lock metadata is invalid.");
  }

  return record as ShareDataRootLockRecord;
}

function assertLockRecordBoundToDataRoot(
  record: ShareDataRootLockRecord,
  dataRoot: string,
  dataRootIdentity: BigIntStats
): void {
  if (
    record.dataRoot !== dataRoot ||
    record.dataRootDevice !== dataRootIdentity.dev.toString() ||
    record.dataRootInode !== dataRootIdentity.ino.toString()
  ) {
    throw new ShareDataRootLockedError(
      `Share data directory "${dataRoot}" contains a lock bound to a different directory identity.`
    );
  }
}

function assertSafeOwnerLockStat(stat: BigIntStats, expectedBytes: number, lockPath: string): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.size !== BigInt(expectedBytes) ||
    !hasMode(stat, 0o600n)
  ) {
    throw unsafeLockError(lockPath);
  }
}

function assertSafePublishedLockStat(stat: BigIntStats): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 2n ||
    stat.size <= 0n ||
    stat.size > BigInt(MAX_LOCK_FILE_BYTES) ||
    !hasMode(stat, 0o600n)
  ) {
    throw new Error("Published share data directory lock has unsafe file metadata.");
  }
}

async function assertDataRootIdentity(
  dataRoot: string,
  expectedIdentity: BigIntStats
): Promise<void> {
  const current = await lstat(dataRoot, { bigint: true });
  if (
    !current.isDirectory() ||
    !hasMode(current, 0o700n) ||
    !isSameFileSystemObject(current, expectedIdentity)
  ) {
    throw new Error(`Share data directory "${dataRoot}" changed while managing its process lock.`);
  }
}

async function assertLockLinkIdentity(lockPath: string, expected: BigIntStats): Promise<void> {
  const current = await lstat(lockPath, { bigint: true });
  if (
    !current.isFile() ||
    !hasMode(current, 0o600n) ||
    !isSameFileSystemObject(current, expected)
  ) {
    throw unsafeLockError(lockPath);
  }
}

async function unlinkLockLinkIfUnchanged(
  dataRoot: string,
  dataRootIdentity: BigIntStats,
  lockPath: string,
  expectedIdentity: BigIntStats
): Promise<void> {
  try {
    await assertDataRootIdentity(dataRoot, dataRootIdentity);
    await assertLockLinkIdentity(lockPath, expectedIdentity);
    await unlink(lockPath);
  } catch (error) {
    if (hasFileSystemErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

function ownerFileName(pid: number, nonce: string): string {
  return `.share-server.lock.owner.${pid}.${nonce}`;
}

function isLocalProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasFileSystemErrorCode(error, "EPERM")) {
      return true;
    }
    if (hasFileSystemErrorCode(error, "ESRCH")) {
      return false;
    }
    throw error;
  }
}

async function writeFileHandleFully(handle: FileHandle, payload: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < payload.byteLength) {
    const { bytesWritten } = await handle.write(
      payload,
      offset,
      payload.byteLength - offset,
      offset
    );
    if (bytesWritten <= 0) {
      throw new Error("Share data directory lock write made no progress.");
    }
    offset += bytesWritten;
  }
}

async function readFileHandleExactly(handle: FileHandle, size: number): Promise<Uint8Array> {
  const payload = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(payload, offset, size - offset, offset);
    if (bytesRead <= 0) {
      throw new Error("Share data directory lock ended before its recorded size.");
    }
    offset += bytesRead;
  }
  return payload;
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(directoryPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    await handle.sync();
  } catch {
    // Some supported filesystems do not allow directory handles to be synced.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function hasMode(stat: BigIntStats, expectedMode: bigint): boolean {
  return process.platform === "win32" || (stat.mode & 0o777n) === expectedMode;
}

function assertSameFileSystemObject(
  current: BigIntStats,
  expected: BigIntStats,
  lockPath: string
): void {
  if (!isSameFileSystemObject(current, expected)) {
    throw unsafeLockError(lockPath);
  }
}

function isSameFileSystemObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unsafeLockError(lockPath: string, cause?: unknown): Error {
  return new Error(`Unsafe share data directory lock path "${lockPath}".`, { cause });
}

function hasFileSystemErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
