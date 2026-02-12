export type PlayerStatus = "idle" | "loaded";

export function getDefaultPlayerStatus(): PlayerStatus {
  return "idle";
}
