import type { WebBlackboxEvent } from "@webblackbox/protocol";
import type { NetworkWaterfallEntry } from "@webblackbox/player-sdk";

export type TriageStats = {
  firstError: WebBlackboxEvent | null;
  slowestRequest: NetworkWaterfallEntry | null;
  failedRequests: number;
  slowRequests: number;
};

export function findFirstErrorEvent(events: WebBlackboxEvent[]): WebBlackboxEvent | null {
  return events.find((event) => event.lvl === "error" || event.type.startsWith("error.")) ?? null;
}

export function findSlowestRequest(entries: NetworkWaterfallEntry[]): NetworkWaterfallEntry | null {
  if (entries.length === 0) {
    return null;
  }

  return entries.reduce((current, entry) =>
    entry.durationMs > current.durationMs ? entry : current
  );
}

export function computeTriageStats(
  events: WebBlackboxEvent[],
  entries: NetworkWaterfallEntry[],
  slowRequestMs: number
): TriageStats {
  const failedRequests = entries.filter((entry) => entry.failed).length;
  const slowRequests = entries.filter((entry) => entry.durationMs >= slowRequestMs).length;

  return {
    firstError: findFirstErrorEvent(events),
    slowestRequest: findSlowestRequest(entries),
    failedRequests,
    slowRequests
  };
}
