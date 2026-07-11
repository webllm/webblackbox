import { describe, expect, it, vi } from "vitest";

import {
  ScreenRecordingChunkDeliveryRegistry,
  parseActiveScreenRecordingSessionIds,
  pauseScreenRecordingForPortDisconnect,
  quiesceExpectedScreenRecordingForStop,
  quiesceScreenRecordingForStop,
  reconcileScreenRecordingsWithWorkerSessions,
  resumeScreenRecordingAfterPortReconnect,
  type PortBoundScreenRecording
} from "./screen-recording-port.js";

const CHUNK_HASH = "a".repeat(64);

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
  it("retains and replays an exact chunk until the worker durably acknowledges it", async () => {
    const registry = new ScreenRecordingChunkDeliveryRegistry();
    const message = {
      kind: "offscreen.screen-recording-chunk" as const,
      sid: "S-durable",
      recordingId: "VR-durable",
      index: 3,
      mime: "video/webm",
      bytes: new Uint8Array([1, 2, 3]),
      size: 3,
      startOffsetMs: 10,
      endOffsetMs: 20,
      durationMs: 10
    };
    const delivery = registry.track(message);
    const post = vi.fn(() => true);

    expect(registry.replay(post)).toBe(1);
    expect(registry.replay(post)).toBe(1);
    expect(post).toHaveBeenNthCalledWith(1, message);
    expect(post).toHaveBeenNthCalledWith(2, message);
    expect(registry.size).toBe(1);
    expect(
      registry.acknowledge({
        kind: "sw.screen-recording-chunk-ack",
        sid: message.sid,
        recordingId: message.recordingId,
        index: message.index,
        size: 4,
        chunkId: CHUNK_HASH
      })
    ).toBe(false);
    expect(registry.size).toBe(1);

    expect(
      registry.acknowledge({
        kind: "sw.screen-recording-chunk-ack",
        sid: message.sid,
        recordingId: message.recordingId,
        index: message.index,
        size: message.size,
        chunkId: CHUNK_HASH
      })
    ).toBe(true);
    await expect(delivery).resolves.toMatchObject({ chunkId: CHUNK_HASH });
    expect(registry.size).toBe(0);
  });

  it("rejects retained chunks explicitly when durable delivery times out", async () => {
    const registry = new ScreenRecordingChunkDeliveryRegistry();
    const delivery = registry.track({
      kind: "offscreen.screen-recording-chunk",
      sid: "S-timeout",
      recordingId: "VR-timeout",
      index: 0,
      mime: "video/webm",
      bytes: new Uint8Array([9]),
      size: 1
    });

    expect(
      registry.failRecording("S-timeout", "VR-timeout", new Error("durable ack timeout"))
    ).toBe(1);
    await expect(delivery).rejects.toThrow("durable ack timeout");
    expect(registry.size).toBe(0);
  });

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

  it("quiesces pixel production without destroying the recorder before durable stop", () => {
    const recording = { ...createRecording(), quiescedForStop: false };

    expect(quiesceScreenRecordingForStop(recording)).toBe(true);
    expect(recording.quiescedForStop).toBe(true);
    expect(recording.recorder.state).toBe("paused");
    expect(recording.stream.getTracks().every((track) => !track.enabled)).toBe(true);
  });

  it("quiesces the actual recorder before rejecting a stale expected identity", () => {
    const recording = {
      ...createRecording(),
      recordingId: "VR-actual",
      quiescedForStop: false
    };

    expect(() => quiesceExpectedScreenRecordingForStop(recording, "VR-stale")).toThrow(
      "identity changed"
    );
    expect(recording.quiescedForStop).toBe(true);
    expect(recording.recorder.state).toBe("paused");
    expect(recording.stream.getTracks().every((track) => !track.enabled)).toBe(true);
    expect(quiesceExpectedScreenRecordingForStop(undefined, "VR-missing")).toBe(true);
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
