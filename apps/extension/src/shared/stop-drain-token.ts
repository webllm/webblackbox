const STOP_DRAIN_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export function isStopDrainToken(value: unknown): value is string {
  return typeof value === "string" && STOP_DRAIN_TOKEN_PATTERN.test(value);
}
