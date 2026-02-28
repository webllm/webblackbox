import type { NetworkWaterfallEntry } from "@webblackbox/player-sdk";

import { compactText } from "./text.js";

export function describeRequestName(url: string): {
  name: string;
  host: string;
} {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname || "/";
    const basename = path === "/" ? "/" : (path.split("/").filter(Boolean).pop() ?? path);
    const query = parsed.search ? parsed.search : "";
    const displayName = compactText(`${basename}${query}`, 120);
    return {
      name: displayName || parsed.hostname,
      host: parsed.hostname
    };
  } catch {
    return {
      name: compactText(url, 120),
      host: ""
    };
  }
}

export function resolveNetworkInitiator(entry: NetworkWaterfallEntry): string {
  if (entry.actionId && entry.actionId.length > 0) {
    const maybeActionNumber = /(\d+)$/.exec(entry.actionId)?.[1];

    if (maybeActionNumber) {
      return `action #${maybeActionNumber}`;
    }

    return compactText(entry.actionId, 24);
  }

  return "(direct)";
}
