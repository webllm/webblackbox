export type CdpRouterState = "idle" | "attached";

export function getDefaultCdpRouterState(): CdpRouterState {
  return "idle";
}
