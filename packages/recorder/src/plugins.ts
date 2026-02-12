import type { RecorderConfig, WebBlackboxEvent } from "@webblackbox/protocol";

import type { RawRecorderEvent } from "./types.js";

export type RecorderPluginContext = {
  config: RecorderConfig;
};

export type RecorderPlugin = {
  name: string;
  onRawEvent?: (
    event: RawRecorderEvent,
    context: RecorderPluginContext
  ) => RawRecorderEvent | null | void;
  onEvent?: (
    event: WebBlackboxEvent,
    context: RecorderPluginContext
  ) => WebBlackboxEvent | null | void;
};

export function createRouteContextPlugin(): RecorderPlugin {
  const routeByStream = new Map<string, string>();

  return {
    name: "route-context",
    onEvent(event) {
      const streamKey = `${event.sid}:${event.tab}:${event.frame ?? "root"}`;
      const payload = asRecord(event.data);
      const url = asString(payload?.url);

      if ((event.type === "nav.commit" || event.type === "nav.hash") && url) {
        routeByStream.set(streamKey, url);

        return withMergedData(event, {
          routeContext: {
            url,
            source: "navigation"
          }
        });
      }

      const currentRoute = routeByStream.get(streamKey);

      if (!currentRoute) {
        return undefined;
      }

      return withMergedData(event, {
        routeContext: {
          url: currentRoute,
          source: "plugin"
        }
      });
    }
  };
}

export function createErrorFingerprintPlugin(): RecorderPlugin {
  return {
    name: "error-fingerprint",
    onEvent(event) {
      if (!event.type.startsWith("error.")) {
        return undefined;
      }

      const payload = asRecord(event.data);
      const base = [
        asString(payload?.message),
        asString(payload?.text),
        asString(payload?.reason),
        asString(payload?.stack)
      ]
        .filter((item): item is string => Boolean(item))
        .join("|");

      const fingerprint = base.length > 0 ? simpleHash(base) : simpleHash(event.type);

      return withMergedData(event, {
        fingerprint,
        fingerprintSource: "plugin"
      });
    }
  };
}

export function createDefaultRecorderPlugins(): RecorderPlugin[] {
  return [createRouteContextPlugin(), createErrorFingerprintPlugin()];
}

function withMergedData(event: WebBlackboxEvent, patch: Record<string, unknown>): WebBlackboxEvent {
  const payload = asRecord(event.data);

  return {
    ...event,
    data: payload
      ? {
          ...payload,
          ...patch
        }
      : patch
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function simpleHash(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return `fp-${Math.abs(hash).toString(36)}`;
}
