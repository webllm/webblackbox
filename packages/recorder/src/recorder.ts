import {
  EventIdFactory,
  type FreezeReason,
  type RecorderConfig,
  type WebBlackboxEvent
} from "@webblackbox/protocol";

import { ActionSpanTracker } from "./action-span.js";
import { FreezePolicy } from "./freeze.js";
import { DefaultEventNormalizer } from "./normalizer.js";
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

  public constructor(
    private readonly config: RecorderConfig,
    private readonly hooks: RecorderHooks = {},
    private readonly normalizer: EventNormalizer = new DefaultEventNormalizer()
  ) {
    this.ringBuffer = new EventRingBuffer(config.ringBufferMinutes);
    this.actionSpanTracker = new ActionSpanTracker(config.sampling.actionWindowMs);
    this.freezePolicy = new FreezePolicy(config);
  }

  public ingest(raw: RawRecorderEvent): RecorderIngestResult {
    const normalized = this.normalizer.normalize(raw);

    if (!normalized) {
      return {};
    }

    const redactedPayload = redactPayload(normalized.payload, this.config.redaction);

    const event: WebBlackboxEvent = {
      v: 1,
      sid: raw.sid,
      tab: raw.tabId,
      nav: raw.nav,
      frame: raw.frame,
      tgt: raw.targetId,
      cdp: raw.cdpSessionId,
      t: raw.t,
      mono: raw.mono,
      type: normalized.eventType,
      id: this.idFactory.next(),
      data: redactedPayload
    };

    const actionLinkedEvent = this.actionSpanTracker.assign(event);
    this.ringBuffer.push(actionLinkedEvent);

    this.hooks.onEvent?.(actionLinkedEvent);

    const freezeReason = this.freezePolicy.evaluate(actionLinkedEvent);

    if (freezeReason) {
      this.hooks.onFreeze?.(freezeReason, actionLinkedEvent);
    }

    return {
      event: actionLinkedEvent,
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
}
