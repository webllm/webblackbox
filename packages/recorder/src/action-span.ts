import { createActionId, type EventReference, type WebBlackboxEvent } from "@webblackbox/protocol";

const ACTION_START_EVENTS = new Set([
  "user.click",
  "user.dblclick",
  "user.submit",
  "user.marker",
  "nav.commit"
]);

const KEYBOARD_ACTION_KEYS = new Set(["Enter", "NumpadEnter", "Space"]);

type ActionState = {
  id: string;
  startedAtMono: number;
  expiresAtMono: number;
};

export class ActionSpanTracker {
  private sequence = 0;

  private currentAction: ActionState | null = null;

  private readonly reqToAction = new Map<string, string>();

  public constructor(private readonly actionWindowMs: number) {}

  public assign(event: WebBlackboxEvent): WebBlackboxEvent {
    const isActionStart = this.isActionStartEvent(event);

    if (isActionStart) {
      this.sequence += 1;
      this.currentAction = {
        id: createActionId(this.sequence),
        startedAtMono: event.mono,
        expiresAtMono: event.mono + this.actionWindowMs
      };
      return this.withRef(event, { act: this.currentAction.id });
    }

    const activeAction = this.currentAction;
    const shouldAttachCurrentAction = Boolean(
      activeAction && event.mono <= activeAction.expiresAtMono
    );
    let actionId = shouldAttachCurrentAction ? activeAction?.id : undefined;

    if (event.type === "network.request") {
      const reqId = this.readReqId(event);

      if (reqId && actionId) {
        this.reqToAction.set(reqId, actionId);
      }
    }

    if (!actionId && event.type.startsWith("network.")) {
      const reqId = this.readReqId(event);
      actionId = reqId ? this.reqToAction.get(reqId) : undefined;
    }

    if (!actionId && event.type.startsWith("dom.")) {
      const reqId = this.readReqId(event);
      actionId = reqId ? this.reqToAction.get(reqId) : undefined;
    }

    if (actionId) {
      return this.withRef(event, { act: actionId });
    }

    return event;
  }

  private isActionStartEvent(event: WebBlackboxEvent): boolean {
    if (ACTION_START_EVENTS.has(event.type)) {
      return true;
    }

    if (event.type !== "user.keydown") {
      return false;
    }

    const payload = this.asRecord(event.data);
    const key = payload?.key;
    return typeof key === "string" && KEYBOARD_ACTION_KEYS.has(key);
  }

  private withRef(event: WebBlackboxEvent, refPatch: EventReference): WebBlackboxEvent {
    return {
      ...event,
      ref: {
        ...event.ref,
        ...refPatch
      }
    };
  }

  private readReqId(event: WebBlackboxEvent): string | undefined {
    const payload = this.asRecord(event.data);
    const reqId = payload?.reqId;

    if (typeof reqId === "string" && reqId.length > 0) {
      return reqId;
    }

    if (typeof event.ref?.req === "string" && event.ref.req.length > 0) {
      return event.ref.req;
    }

    return undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
