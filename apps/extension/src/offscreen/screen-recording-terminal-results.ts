export const SCREEN_RECORDING_TERMINAL_RESULT_DEFAULT_TTL_MS = 5 * 60_000;
export const SCREEN_RECORDING_TERMINAL_RESULT_DEFAULT_MAX_ENTRIES = 256;

export type ScreenRecordingTerminalResult = Readonly<{
  recordingId: string;
}>;

export type ScreenRecordingTerminalResultRegistryOptions = Readonly<{
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}>;

type TerminalResultEntry<TResult extends ScreenRecordingTerminalResult> = Readonly<{
  sid: string;
  result: TResult;
  expiresAt: number;
}>;

/**
 * Retains successful screen-recording stop results long enough for the service worker to retry a
 * request whose response was lost. Entries are isolated by session and recording id, expire after
 * a bounded TTL, and are evicted oldest-first at the global capacity limit.
 */
export class ScreenRecordingTerminalResultRegistry<TResult extends ScreenRecordingTerminalResult> {
  private readonly entries = new Map<string, TerminalResultEntry<TResult>>();

  private readonly ttlMs: number;

  private readonly maxEntries: number;

  private readonly now: () => number;

  public constructor(options: ScreenRecordingTerminalResultRegistryOptions = {}) {
    this.ttlMs = requirePositiveSafeInteger(
      options.ttlMs ?? SCREEN_RECORDING_TERMINAL_RESULT_DEFAULT_TTL_MS,
      "Screen-recording terminal-result TTL"
    );
    this.maxEntries = requirePositiveSafeInteger(
      options.maxEntries ?? SCREEN_RECORDING_TERMINAL_RESULT_DEFAULT_MAX_ENTRIES,
      "Screen-recording terminal-result entry limit"
    );
    this.now = options.now ?? Date.now;
  }

  public get(sid: string, recordingId: string): TResult | undefined {
    const now = this.readNow();
    this.pruneExpired(now);
    return this.entries.get(serializeKey(sid, recordingId))?.result;
  }

  public remember(sid: string, recordingId: string, result: TResult): TResult {
    if (result.recordingId !== recordingId) {
      throw new Error("Screen-recording terminal result id does not match its cache key.");
    }

    const now = this.readNow();
    this.pruneExpired(now);
    const key = serializeKey(sid, recordingId);
    const existing = this.entries.get(key);

    if (existing) {
      return existing.result;
    }

    this.makeCapacity();
    this.entries.set(key, {
      sid,
      result,
      expiresAt: now + this.ttlMs
    });
    return result;
  }

  public assertStartAllowed(sid: string, recordingId: string): void {
    if (this.get(sid, recordingId)) {
      throw new Error(`Screen recording id was already completed for session: ${sid}`);
    }
  }

  public clearSession(sid: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sid === sid) {
        this.entries.delete(key);
      }
    }
  }

  private makeCapacity(): void {
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;

      if (oldestKey === undefined) {
        return;
      }

      this.entries.delete(oldestKey);
    }
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private readNow(): number {
    const value = this.now();

    if (!Number.isFinite(value)) {
      throw new Error("Screen-recording terminal-result clock must return a finite number.");
    }

    return value;
  }
}

function serializeKey(sid: string, recordingId: string): string {
  return JSON.stringify([sid, recordingId]);
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }

  return value;
}
