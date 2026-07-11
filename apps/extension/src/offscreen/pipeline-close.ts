export type ClosableOffscreenPipeline = {
  close(options: { purge: boolean }): void | Promise<void>;
};

export type SessionRegistry = {
  clearSession(sid: string): void;
};

export async function closeOffscreenPipelineSession<
  TPipeline extends ClosableOffscreenPipeline
>(input: {
  sid: string;
  purge: boolean;
  pipelines: Map<string, TPipeline>;
  stopScreenRecording: () => unknown | Promise<unknown>;
  ingestIdempotencyRegistry: SessionRegistry;
  screenRecordingTerminalResults: SessionRegistry;
  onScreenRecordingStopError?: (error: unknown) => void;
}): Promise<void> {
  try {
    await input.stopScreenRecording();
  } catch (error) {
    input.onScreenRecordingStopError?.(error);
  }

  const pipeline = input.pipelines.get(input.sid);

  if (pipeline) {
    await pipeline.close({ purge: input.purge });
  }

  input.pipelines.delete(input.sid);
  input.ingestIdempotencyRegistry.clearSession(input.sid);
  input.screenRecordingTerminalResults.clearSession(input.sid);
}
