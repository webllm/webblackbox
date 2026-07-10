export type PortBoundScreenRecording = {
  recorder: Pick<MediaRecorder, "state" | "pause" | "resume">;
  stream: Pick<MediaStream, "getTracks">;
  stopping: boolean;
  pausedForPortDisconnect: boolean;
};

export type SessionBoundScreenRecording = PortBoundScreenRecording & { sid: string };

export type ScreenRecordingHandshakeFailure<TRecording extends SessionBoundScreenRecording> = {
  recording: TRecording;
  reason: "service-worker-session-not-active" | "service-worker-reconnect-failed";
};

/** Parses an active-session list only after the current worker has finished state restoration. */
export function parseActiveScreenRecordingSessionIds(status: unknown): ReadonlySet<string> | null {
  if (status === null || typeof status !== "object" || Array.isArray(status)) {
    return null;
  }

  const record = status as Record<string, unknown>;
  const sessions = record.sessions;
  if (
    record.runtimeStateRestored !== true ||
    !Array.isArray(sessions) ||
    sessions.length > 10_000
  ) {
    return null;
  }

  const activeSessionIds = new Set<string>();
  for (const item of sessions) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }

    const record = item as Record<string, unknown>;
    if (typeof record.sid !== "string" || record.sid.length === 0 || record.sid.length > 256) {
      return null;
    }
    if (record.active !== true) {
      return null;
    }
    activeSessionIds.add(record.sid);
  }

  return activeSessionIds;
}

/** Resumes only recordings claimed by the restored worker and reports every fail-closed stop. */
export function reconcileScreenRecordingsWithWorkerSessions<
  TRecording extends SessionBoundScreenRecording
>(
  recordings: Iterable<TRecording>,
  activeSessionIds: ReadonlySet<string>
): ScreenRecordingHandshakeFailure<TRecording>[] {
  const failures: ScreenRecordingHandshakeFailure<TRecording>[] = [];
  for (const recording of recordings) {
    if (!activeSessionIds.has(recording.sid)) {
      failures.push({ recording, reason: "service-worker-session-not-active" });
      continue;
    }
    if (!resumeScreenRecordingAfterPortReconnect(recording)) {
      failures.push({ recording, reason: "service-worker-reconnect-failed" });
    }
  }
  return failures;
}

/** Suspends sensitive media production while the service worker cannot receive chunks. */
export function pauseScreenRecordingForPortDisconnect(
  recording: PortBoundScreenRecording
): boolean {
  if (recording.stopping) {
    return true;
  }

  for (const track of recording.stream.getTracks()) {
    track.enabled = false;
  }

  try {
    if (recording.recorder.state === "recording") {
      recording.recorder.pause();
    } else if (recording.recorder.state !== "paused") {
      return false;
    }
    recording.pausedForPortDisconnect = true;
    return true;
  } catch {
    return false;
  }
}

/** Resumes only recordings that this disconnect path suspended. */
export function resumeScreenRecordingAfterPortReconnect(
  recording: PortBoundScreenRecording
): boolean {
  if (!recording.pausedForPortDisconnect || recording.stopping) {
    return true;
  }

  try {
    if (recording.recorder.state === "paused") {
      recording.recorder.resume();
    } else if (recording.recorder.state !== "recording") {
      return false;
    }
    for (const track of recording.stream.getTracks()) {
      track.enabled = true;
    }
    recording.pausedForPortDisconnect = false;
    return true;
  } catch {
    return false;
  }
}
