import { extractRequestId, type WebBlackboxEvent } from "@webblackbox/protocol";

export type ScopeFilter = "all" | "main" | "iframe";
export type EventScope = "main" | "iframe";

export type ActionSpanScopeInput = {
  actId: string;
  eventIds: string[];
};

type ScopeEventLike = Pick<WebBlackboxEvent, "cdp" | "frame" | "ref" | "data">;

export function inferEventScope(event: Pick<WebBlackboxEvent, "cdp" | "frame">): EventScope {
  if ((event.cdp && event.cdp.length > 0) || (event.frame && event.frame.length > 0)) {
    return "iframe";
  }

  return "main";
}

export function mergeEventScopes(current: EventScope | undefined, next: EventScope): EventScope {
  if (current === "iframe" || next === "iframe") {
    return "iframe";
  }

  return "main";
}

export function matchesScopeFilter(scope: EventScope, filter: ScopeFilter): boolean {
  if (filter === "all") {
    return true;
  }

  return scope === filter;
}

export function extractReqIdFromEvent(
  event: Pick<WebBlackboxEvent, "ref" | "data">
): string | null {
  return extractRequestId(event);
}

export function buildActionScopeIndex(
  actionSpans: ActionSpanScopeInput[],
  eventById: Map<string, ScopeEventLike>,
  requestScopeByReqId: Map<string, EventScope>
): Map<string, EventScope> {
  const scopesByActionId = new Map<string, EventScope>();

  for (const span of actionSpans) {
    let scope: EventScope = "main";

    for (const eventId of span.eventIds) {
      const event = eventById.get(eventId);

      if (!event) {
        continue;
      }

      if (inferEventScope(event) === "iframe") {
        scope = "iframe";
        break;
      }

      const reqId = extractReqIdFromEvent(event);

      if (reqId && requestScopeByReqId.get(reqId) === "iframe") {
        scope = "iframe";
        break;
      }
    }

    scopesByActionId.set(span.actId, scope);
  }

  return scopesByActionId;
}
