export type PipelineStatus = "stopped" | "running";

export function getDefaultPipelineStatus(): PipelineStatus {
  return "stopped";
}
