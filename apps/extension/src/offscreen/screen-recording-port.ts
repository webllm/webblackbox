export type PortBoundScreenRecording = {
  recorder: Pick<MediaRecorder, "state" | "pause" | "resume">;
  stream: Pick<MediaStream, "getTracks">;
  stopping: boolean;
  pausedForPortDisconnect: boolean;
};

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
