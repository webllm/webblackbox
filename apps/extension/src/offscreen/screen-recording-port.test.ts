import { describe, expect, it, vi } from "vitest";

import {
  pauseScreenRecordingForPortDisconnect,
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
});
