export const CONTENT_EVENT_FLUSH_CHUNK = 120;
export const CONTENT_EVENT_FLUSH_URGENT_THRESHOLD = 360;
export const CONTENT_EVENT_FLUSH_URGENT_MS = 8;
export const CONTENT_EVENT_FLUSH_SOON_MS = 16;
export const CONTENT_EVENT_FLUSH_IDLE_MS = 24;

export function resolveContentEventFlushDelay(queueLength: number, urgent = false): number {
  if (urgent) {
    return CONTENT_EVENT_FLUSH_URGENT_MS;
  }

  if (queueLength >= CONTENT_EVENT_FLUSH_URGENT_THRESHOLD) {
    return CONTENT_EVENT_FLUSH_URGENT_MS;
  }

  if (queueLength >= CONTENT_EVENT_FLUSH_CHUNK) {
    return CONTENT_EVENT_FLUSH_SOON_MS;
  }

  return CONTENT_EVENT_FLUSH_IDLE_MS;
}
