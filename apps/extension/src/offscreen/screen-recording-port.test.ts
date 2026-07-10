import { describe, expect, it, vi } from "vitest";

import {
  parseActiveScreenRecordingSessionIds,
  pauseScreenRecordingForPortDisconnect,
  reconcileScreenRecordingsWithWorkerSessions,
  resumeScreenRecordingAfterPortReconnect,
  type PortBoundScreenRecording
} from "./screen-recording-port.js";

function createRecording(): PortBoundScreenRecording & {
  recorder: PortBoundScreenRecording["recorder"] & { state: RecordingState };
} {
  const tracks = [{ enabled: true }, { enabled: true }] as MediaStreamTrack[];
  const recorder = {
    state: "recording" as RecordingState,
    pause: vi.fn(() => {
      recorder.state = "paused";
    }),
    resume: vi.fn(() => {
      recorder.state = "recording";
    })
  };

  return {
    recorder,
    stream: {
      getTracks: () => tracks
    },
    stopping: false,
    pausedForPortDisconnect: false
  };
}

describe("screen recording port lifecycle", () => {
  it("accepts only an authoritative bounded list of active session ids", () => {
    expect(
      parseActiveScreenRecordingSessionIds({
        runtimeStateRestored: true,
        sessions: [
          { sid: "S-active-1", active: true, tabId: 1 },
          { sid: "S-active-2", active: true, tabId: 2 }
        ]
      })
    ).toEqual(new Set(["S-active-1", "S-active-2"]));
    expect(
      parseActiveScreenRecordingSessionIds({
        runtimeStateRestored: false,
        sessions: [{ sid: "S-active-1", active: true }]
      })
    ).toBeNull();
    expect(
      parseActiveScreenRecordingSessionIds({
        runtimeStateRestored: true,
        sessions: [{ sid: "S-stopped", active: false }]
      })
    ).toBeNull();
    expect(
      parseActiveScreenRecordingSessionIds({
        runtimeStateRestored: true,
        sessions: [{ sid: "", active: true }]
      })
    ).toBeNull();
    expect(parseActiveScreenRecordingSessionIds({ sid: "S-not-an-array" })).toBeNull();
  });

  it("disables tracks and pauses until the worker port reconnects", () => {
    const recording = createRecording();

    expect(pauseScreenRecordingForPortDisconnect(recording)).toBe(true);
    expect(recording.recorder.pause).toHaveBeenCalledOnce();
    expect(recording.stream.getTracks().every((track) => !track.enabled)).toBe(true);
    expect(resumeScreenRecordingAfterPortReconnect(recording)).toBe(true);
    expect(recording.recorder.resume).toHaveBeenCalledOnce();
    expect(recording.stream.getTracks().every((track) => track.enabled)).toBe(true);
  });

  it("fails closed when an inactive recorder cannot be suspended", () => {
    const recording = createRecording();
    recording.recorder.state = "inactive";

    expect(pauseScreenRecordingForPortDisconnect(recording)).toBe(false);
    expect(recording.stream.getTracks().every((track) => !track.enabled)).toBe(true);
  });

  it("resumes only recordings claimed by the restored worker handshake", () => {
    const claimed = { ...createRecording(), sid: "S-claimed" };
    const unclaimed = { ...createRecording(), sid: "S-unclaimed" };
    pauseScreenRecordingForPortDisconnect(claimed);
    pauseScreenRecordingForPortDisconnect(unclaimed);

    const failures = reconcileScreenRecordingsWithWorkerSessions(
      [claimed, unclaimed],
      new Set(["S-claimed"])
    );

    expect(claimed.recorder.resume).toHaveBeenCalledOnce();
    expect(claimed.stream.getTracks().every((track) => track.enabled)).toBe(true);
    expect(unclaimed.recorder.resume).not.toHaveBeenCalled();
    expect(unclaimed.stream.getTracks().every((track) => !track.enabled)).toBe(true);
    expect(failures).toEqual([
      {
        recording: unclaimed,
        reason: "service-worker-session-not-active"
      }
    ]);
  });
});
