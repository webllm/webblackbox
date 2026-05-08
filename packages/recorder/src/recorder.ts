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
    const privacy = classifyPrivacy(
      normalized.eventType,
      redactedPayload,
      this.config.capturePolicy
    );
    const violation = evaluateCapturePolicy(
      normalized.eventType,
      redactedPayload,
      privacy,
      this.config.capturePolicy
    );

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
      type: violation ? "privacy.violation" : normalized.eventType,
      id: this.idFactory.next(),
      privacy: violation
        ? {
            category: "system",
            sensitivity: "medium",
            redacted: true
          }
        : privacy,
      data: violation ?? redactedPayload
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

type PrivacyViolationPayload = {
  blockedType: WebBlackboxEventType;
  category: PrivacyClassification["category"];
  sensitivity: PrivacyClassification["sensitivity"];
  reason: string;
  policyMode: CapturePolicy["mode"] | "missing";
  redacted: true;
};

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

function evaluateCapturePolicy(
  eventType: WebBlackboxEventType,
  payload: unknown,
  privacy: PrivacyClassification,
  policy: CapturePolicy | undefined
): PrivacyViolationPayload | null {
  if (eventType === "privacy.violation") {
    return null;
  }

  if (!policy) {
    return createPrivacyViolation(eventType, privacy, "missing-capture-policy", "missing");
  }

  const reason = findPolicyViolationReason(eventType, payload, policy);

  if (!reason) {
    return null;
  }

  return createPrivacyViolation(eventType, privacy, reason, policy.mode);
}

function createPrivacyViolation(
  eventType: WebBlackboxEventType,
  privacy: PrivacyClassification,
  reason: string,
  policyMode: CapturePolicy["mode"] | "missing"
): PrivacyViolationPayload {
  return {
    blockedType: eventType,
    category: privacy.category,
    sensitivity: privacy.sensitivity,
    reason,
    policyMode,
    redacted: true
  };
}

function findPolicyViolationReason(
  eventType: WebBlackboxEventType,
  payload: unknown,
  policy: CapturePolicy
): string | null {
  if (eventType === "screen.screenshot" && policy.categories.screenshots === "off") {
    return "screenshots-disabled";
  }

  if (eventType === "network.body" && policy.categories.network !== "body-allowlist") {
    return "network-body-disabled";
  }

  if (eventType === "dom.snapshot") {
    if (policy.categories.dom === "off") {
      return "dom-disabled";
    }

    if (policy.categories.dom !== "allow" && hasBlobReference(payload)) {
      return "dom-raw-snapshot-disabled";
    }
  }

  if (eventType.startsWith("dom.") && policy.categories.dom === "off") {
    return "dom-disabled";
  }

  if (eventType === "user.input") {
    if (policy.categories.inputs === "none") {
      return "inputs-disabled";
    }

    if (policy.categories.inputs === "length-only" && hasRawInputValue(payload)) {
      return "raw-input-value-disabled";
    }
  }

  if (eventType.startsWith("console.") || eventType.startsWith("error.")) {
    if (policy.categories.console === "off") {
      return "console-disabled";
    }

    if (policy.categories.console === "metadata" && hasConsoleTextPayload(payload)) {
      return "console-payload-disabled";
    }
  }

  if (eventType.startsWith("storage.")) {
    if (isStorageDisabledByPolicy(eventType, policy)) {
      return "storage-disabled";
    }

    if (isStorageCountsOnlyByPolicy(eventType, policy) && hasStorageDetail(payload)) {
      return "storage-detail-disabled";
    }
  }

  if (
    eventType === "perf.heap.snapshot" &&
    (policy.categories.heapProfiles !== "lab-only" || policy.mode !== "lab")
  ) {
    return "heap-profile-disabled";
  }

  if (
    (eventType === "perf.trace" || eventType === "perf.cpu.profile") &&
    policy.categories.cdp !== "full"
  ) {
    return "cdp-profile-disabled";
  }

  return null;
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
  if (eventType === "privacy.violation") {
    return "medium";
  }

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

function isStorageDisabledByPolicy(
  eventType: WebBlackboxEventType,
  policy: CapturePolicy
): boolean {
  if (eventType.startsWith("storage.cookie.")) {
    return policy.categories.cookies === "off";
  }

  if (eventType.startsWith("storage.idb.")) {
    return policy.categories.indexedDb === "off";
  }

  return policy.categories.storage === "off";
}

function isStorageCountsOnlyByPolicy(
  eventType: WebBlackboxEventType,
  policy: CapturePolicy
): boolean {
  if (eventType.startsWith("storage.cookie.")) {
    return policy.categories.cookies === "count-only";
  }

  if (eventType.startsWith("storage.idb.")) {
    return policy.categories.indexedDb === "counts-only";
  }

  return policy.categories.storage === "counts-only";
}

function hasBlobReference(payload: unknown): boolean {
  const row = asRecord(payload);

  if (!row) {
    return false;
  }

  return typeof row.contentHash === "string" || typeof row.hash === "string";
}

function hasRawInputValue(payload: unknown): boolean {
  const row = asRecord(payload);

  if (!row) {
    return false;
  }

  return typeof row.value === "string" || typeof row.text === "string";
}

function hasConsoleTextPayload(payload: unknown): boolean {
  const row = asRecord(payload);

  if (!row) {
    return false;
  }

  const args = row.args;

  return (
    (typeof row.text === "string" && row.text.length > 0) ||
    (typeof row.message === "string" && row.message.length > 0) ||
    (typeof row.stack === "string" && row.stack.length > 0) ||
    (Array.isArray(args) && args.length > 0)
  );
}

function hasStorageDetail(payload: unknown): boolean {
  const row = asRecord(payload);

  if (!row) {
    return false;
  }

  return (
    hasBlobReference(row) ||
    typeof row.key === "string" ||
    Array.isArray(row.names) ||
    Array.isArray(row.databaseNames) ||
    asRecord(row.entries) !== null
  );
}

function hasRedactionSignal(payload: unknown): boolean {
  const row = asRecord(payload);

  if (!row) {
    return false;
  }

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
