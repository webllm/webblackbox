import type { WebBlackboxEvent } from "@webblackbox/protocol";

const PLAYBACK_EVENT_PREFIXES = [
  "nav.",
  "user.",
  "console.",
  "error.",
  "network.",
  "dom.",
  "screen.",
  "storage.",
  "perf."
];

export function hasPlaybackEvents(events: WebBlackboxEvent[]): boolean {
  return events.some((event) =>
    PLAYBACK_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix))
  );
}
