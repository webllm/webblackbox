import {
  EventIdFactory,
  type FreezeReason,
  type RecorderConfig,
  type WebBlackboxEvent
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
      tab: nextRawEvent.tabId,
      nav: nextRawEvent.nav,
      frame: nextRawEvent.frame,
      tgt: nextRawEvent.targetId,
      cdp: nextRawEvent.cdpSessionId,
      t: nextRawEvent.t,
      mono: nextRawEvent.mono,
      type: normalized.eventType,
      id: this.idFactory.next(),
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
