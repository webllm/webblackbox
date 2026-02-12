import type {
  ChunkTimeIndexEntry,
  InvertedIndexEntry,
  RequestIndexEntry,
  WebBlackboxEvent
} from "@webblackbox/protocol";

type MutableIndexes = {
  time: ChunkTimeIndexEntry[];
  request: Map<string, Set<string>>;
  inverted: Map<string, Set<string>>;
};

export class EventIndexer {
  private readonly indexes: MutableIndexes = {
    time: [],
    request: new Map(),
    inverted: new Map()
  };

  public addChunk(meta: ChunkTimeIndexEntry): void {
    this.indexes.time.push(meta);
  }

  public addEvents(events: WebBlackboxEvent[]): void {
    for (const event of events) {
      this.addRequestMapping(event);
      this.addInvertedTerms(event);
    }
  }

  public snapshot(): {
    time: ChunkTimeIndexEntry[];
    request: RequestIndexEntry[];
    inverted: InvertedIndexEntry[];
  } {
    return {
      time: [...this.indexes.time].sort((left, right) => left.seq - right.seq),
      request: [...this.indexes.request.entries()].map(([reqId, eventIds]) => ({
        reqId,
        eventIds: [...eventIds]
      })),
      inverted: [...this.indexes.inverted.entries()].map(([term, eventIds]) => ({
        term,
        eventIds: [...eventIds]
      }))
    };
  }

  private addRequestMapping(event: WebBlackboxEvent): void {
    const payload = asRecord(event.data);
    const reqId =
      event.ref?.req ??
      (typeof payload?.reqId === "string" ? payload.reqId : undefined) ??
      (typeof payload?.requestId === "string" ? payload.requestId : undefined);

    if (!reqId) {
      return;
    }

    const eventIds = this.indexes.request.get(reqId) ?? new Set<string>();
    eventIds.add(event.id);
    this.indexes.request.set(reqId, eventIds);
  }

  private addInvertedTerms(event: WebBlackboxEvent): void {
    const terms = collectTerms(event);

    for (const term of terms) {
      const normalized = term.toLowerCase();

      if (normalized.length < 2) {
        continue;
      }

      const eventIds = this.indexes.inverted.get(normalized) ?? new Set<string>();
      eventIds.add(event.id);
      this.indexes.inverted.set(normalized, eventIds);
    }
  }
}

function collectTerms(event: WebBlackboxEvent): string[] {
  const terms = new Set<string>();
  terms.add(event.type);

  collectFromValue(event.data, terms);

  return [...terms];
}

function collectFromValue(value: unknown, terms: Set<string>): void {
  if (typeof value === "string") {
    tokenize(value, terms);
    return;
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectFromValue(entry, terms);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      tokenize(key, terms);
      collectFromValue(nested, terms);
    }
  }
}

function tokenize(value: string, terms: Set<string>): void {
  const parts = value.split(/[^a-zA-Z0-9_:.\-/]+/g).filter(Boolean);

  for (const part of parts) {
    terms.add(part);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
