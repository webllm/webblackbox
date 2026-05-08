import {
  DEFAULT_CAPTURE_POLICY,
  EventIdFactory,
  type CapturePolicy,
  type FreezeReason,
  type PrivacyClassification,
  type RecorderConfig,
  type WebBlackboxEvent,
  type WebBlackboxEventType
} from "@webblackbox/protocol";

import { ActionSpanTracker } from "./action-span.js";
import { FreezePolicy } from "./freeze.js";
import { DefaultEventNormalizer } from "./normalizer.js";
import type { RecorderPlugin, RecorderPluginContext } from "./plugins.js";
import { redactPayload } from "./redaction.js";
import { EventRingBuffer } from "./ring-buffer.js";
import type { EventNormalizer, RawRecorderEvent, RecorderIngestResult } from "./types.js";

export type RecorderHooks = {
  onEvent?: (event: WebBlackboxEvent) => void;
  onFreeze?: (reason: FreezeReason, event: WebBlackboxEvent) => void;
};

export class WebBlackboxRecorder {
  private readonly idFactory = new EventIdFactory();

  private readonly ringBuffer: EventRingBuffer;

  private readonly actionSpanTracker: ActionSpanTracker;

  private readonly freezePolicy: FreezePolicy;

  private readonly pluginContext: RecorderPluginContext;

  public constructor(
    private readonly config: RecorderConfig,
    private readonly hooks: RecorderHooks = {},
    private readonly normalizer: EventNormalizer = new DefaultEventNormalizer(),
    private readonly plugins: RecorderPlugin[] = []
  ) {
    this.ringBuffer = new EventRingBuffer(config.ringBufferMinutes);
    this.actionSpanTracker = new ActionSpanTracker(config.sampling.actionWindowMs);
    this.freezePolicy = new FreezePolicy(config);
    this.pluginContext = {
      config
    };
  }

  public ingest(raw: RawRecorderEvent): RecorderIngestResult {
    const nextRawEvent = this.applyRawPlugins(raw);

    if (!nextRawEvent) {
      return {};
    }

    const normalized = this.normalizer.normalize(nextRawEvent);

    if (!normalized) {
      return {};
    }

    const redactedPayload = redactPayload(normalized.payload, this.config.redaction);

    const event: WebBlackboxEvent = {
      v: 1,
      sid: nextRawEvent.sid,
      tab: normalizeTabId(nextRawEvent.tabId),
      nav: nextRawEvent.nav,
      frame: nextRawEvent.frame,
      tgt: nextRawEvent.targetId,
      cdp: nextRawEvent.cdpSessionId,
      t: nextRawEvent.t,
      mono: nextRawEvent.mono,
      type: normalized.eventType,
      id: this.idFactory.next(),
      privacy: classifyPrivacy(normalized.eventType, redactedPayload, this.config.capturePolicy),
      data: redactedPayload
    };

    const actionLinkedEvent = this.actionSpanTracker.assign(event);
    const pluginEvent = this.applyEventPlugins(actionLinkedEvent);

    if (!pluginEvent) {
      return {};
    }

    this.ringBuffer.push(pluginEvent);

    this.hooks.onEvent?.(pluginEvent);

    const freezeReason = this.freezePolicy.evaluate(pluginEvent);

    if (freezeReason) {
      this.hooks.onFreeze?.(freezeReason, pluginEvent);
    }

    return {
      event: pluginEvent,
      freezeReason: freezeReason ?? undefined
    };
  }

  public snapshotRingBuffer(): WebBlackboxEvent[] {
    return this.ringBuffer.snapshot();
  }

  public clearRingBuffer(): void {
    this.ringBuffer.clear();
  }

  public getBufferedEventCount(): number {
    return this.ringBuffer.size();
  }

  private applyRawPlugins(raw: RawRecorderEvent): RawRecorderEvent | null {
    let nextRaw = raw;

    for (const plugin of this.plugins) {
      if (!plugin.onRawEvent) {
        continue;
      }

      try {
        const candidate = plugin.onRawEvent(nextRaw, this.pluginContext);

        if (candidate === null) {
          return null;
        }

        if (candidate) {
          nextRaw = candidate;
        }
      } catch (error) {
        console.warn(`[WebBlackbox] plugin '${plugin.name}' raw hook failed`, error);
      }
    }

    return nextRaw;
  }

  private applyEventPlugins(event: WebBlackboxEvent): WebBlackboxEvent | null {
    let nextEvent = event;

    for (const plugin of this.plugins) {
      if (!plugin.onEvent) {
        continue;
      }

      try {
        const candidate = plugin.onEvent(nextEvent, this.pluginContext);

        if (candidate === null) {
          return null;
        }

        if (candidate) {
          nextEvent = candidate;
        }
      } catch (error) {
        console.warn(`[WebBlackbox] plugin '${plugin.name}' event hook failed`, error);
      }
    }

    return nextEvent;
  }
}

function normalizeTabId(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.round(value));
}

function classifyPrivacy(
  eventType: WebBlackboxEventType,
  payload: unknown,
  policy: CapturePolicy | undefined
): PrivacyClassification {
  const effectivePolicy = policy ?? DEFAULT_CAPTURE_POLICY;
  const category = classifyCategory(eventType);
  const sensitivity = classifySensitivity(eventType);

  return {
    category,
    sensitivity,
    redacted:
      isRedactedByPolicy(eventType, category, effectivePolicy) || hasRedactionSignal(payload)
  };
}

function classifyCategory(eventType: WebBlackboxEventType): PrivacyClassification["category"] {
  if (eventType === "user.input") {
    return "inputs";
  }

  if (eventType.startsWith("user.")) {
    return "actions";
  }

  if (eventType.startsWith("dom.")) {
    return "dom";
  }

  if (eventType.startsWith("screen.")) {
    return "screenshots";
  }

  if (eventType.startsWith("console.") || eventType.startsWith("error.")) {
    return "console";
  }

  if (eventType.startsWith("network.")) {
    return "network";
  }

  if (eventType.startsWith("storage.")) {
    return "storage";
  }

  if (eventType.startsWith("perf.")) {
    return "performance";
  }

  return "system";
}

function classifySensitivity(
  eventType: WebBlackboxEventType
): PrivacyClassification["sensitivity"] {
  if (
    eventType === "user.input" ||
    eventType === "dom.snapshot" ||
    eventType === "network.body" ||
    eventType === "screen.screenshot" ||
    eventType.startsWith("storage.")
  ) {
    return "high";
  }

  if (
    eventType.startsWith("dom.") ||
    eventType.startsWith("console.") ||
    eventType.startsWith("error.") ||
    eventType.startsWith("network.")
  ) {
    return "medium";
  }

  return "low";
}

function isRedactedByPolicy(
  eventType: WebBlackboxEventType,
  category: PrivacyClassification["category"],
  policy: CapturePolicy
): boolean {
  switch (category) {
    case "actions":
      return policy.categories.actions !== "allow";
    case "inputs":
      return policy.categories.inputs !== "allow";
    case "dom":
      return policy.categories.dom !== "allow";
    case "screenshots":
      return policy.categories.screenshots !== "allow";
    case "console":
      return policy.categories.console !== "allow";
    case "network":
      return eventType === "network.body"
        ? policy.categories.network !== "body-allowlist"
        : policy.categories.network === "metadata";
    case "storage":
      if (eventType.startsWith("storage.cookie.")) {
        return policy.categories.cookies !== "names-only";
      }

      if (eventType.startsWith("storage.idb.")) {
        return policy.categories.indexedDb !== "names-only";
      }

      return policy.categories.storage !== "allow";
    case "performance":
    case "system":
      return false;
  }
}

function hasRedactionSignal(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const row = payload as Record<string, unknown>;
  const target = row.target;

  return (
    row.redacted === true ||
    row.valueRedacted === true ||
    row.selectorRedacted === true ||
    (target !== null &&
      typeof target === "object" &&
      !Array.isArray(target) &&
      (target as Record<string, unknown>).selectorRedacted === true)
  );
}
