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

export function createAiRootCausePlugin(windowMs = 10_000): RecorderPlugin {
  const recent: WebBlackboxEvent[] = [];

  return {
    name: "ai-root-cause",
    onEvent(event) {
      recent.push(event);

      if (recent.length > 300) {
        recent.splice(0, recent.length - 300);
      }

      if (!event.type.startsWith("error.")) {
        return undefined;
      }

      const windowStart = event.mono - windowMs;
      const scoped = recent.filter((item) => item.id !== event.id && item.mono >= windowStart);
      const suspects: Array<{ type: string; reason: string; eventId?: string }> = [];

      const networkIssue = scoped.find((item) => {
        if (item.type === "network.failed") {
          return true;
        }

        if (item.type !== "network.response") {
          return false;
        }

        const payload = asRecord(item.data);
        const status = asNumber(payload?.status) ?? asNumber(asRecord(payload?.response)?.status);
        return typeof status === "number" && status >= 500;
      });

      if (networkIssue) {
        suspects.push({
          type: "network",
          reason: "A failed or 5xx network response occurred before this error.",
          eventId: networkIssue.id
        });
      }

      const longTask = scoped.find((item) => {
        if (item.type !== "perf.longtask") {
          return false;
        }

        const payload = asRecord(item.data);
        const duration = asNumber(payload?.duration);
        return typeof duration === "number" && duration >= 120;
      });

      if (longTask) {
        suspects.push({
          type: "performance",
          reason: "A long main-thread task happened close to the failure.",
          eventId: longTask.id
        });
      }

      const mutationBurst = scoped.find((item) => {
        if (item.type !== "dom.mutation.batch") {
          return false;
        }

        const payload = asRecord(item.data);
        const count = asNumber(payload?.count);
        return typeof count === "number" && count >= 60;
      });

      if (mutationBurst) {
        suspects.push({
          type: "dom",
          reason: "A large DOM mutation batch appeared before the error.",
          eventId: mutationBurst.id
        });
      }

      if (suspects.length === 0) {
        suspects.push({
          type: "runtime",
          reason: "No strong precursor signal was found; inspect nearby console and runtime events."
        });
      }

      const confidence = Math.min(0.95, 0.35 + suspects.length * 0.2);

      return withMergedData(event, {
        aiRootCause: {
          plugin: "ai-root-cause",
          confidence: Number(confidence.toFixed(2)),
          windowMs,
          suspects
        }
      });
    }
  };
}

export function createDefaultRecorderPlugins(): RecorderPlugin[] {
  return [createRouteContextPlugin(), createErrorFingerprintPlugin(), createAiRootCausePlugin()];
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

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function simpleHash(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return `fp-${Math.abs(hash).toString(36)}`;
}
