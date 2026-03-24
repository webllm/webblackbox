import type {
  ChunkTimeIndexEntry,
  InvertedIndexEntry,
  RequestIndexEntry,
  WebBlackboxEvent
} from "@webblackbox/protocol";
import { extractRequestId } from "@webblackbox/protocol";

type MutableIndexes = {
  time: ChunkTimeIndexEntry[];
  request: Map<string, Set<string>>;
  inverted: Map<string, Set<string>>;
};

const MIN_INDEX_TERM_LENGTH = 2;
const MAX_INDEX_TERM_LENGTH = 64;
const MAX_TERMS_PER_EVENT = 256;
const HASH_HEX_PATTERN = /^[a-f0-9]{32,}$/i;
const BASE64ISH_PATTERN = /^[a-z0-9+/_=-]{80,}$/i;

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
    const reqId = extractRequestId(event);

    if (!reqId) {
      return;
    }

    const eventIds = this.indexes.request.get(reqId) ?? new Set<string>();
    eventIds.add(event.id);
    this.indexes.request.set(reqId, eventIds);
  }

  private addInvertedTerms(event: WebBlackboxEvent): void {
    const terms = collectTerms(event, MAX_TERMS_PER_EVENT);

    for (const term of terms) {
      const normalized = term.toLowerCase();

      if (!shouldIndexTerm(normalized)) {
        continue;
      }

      const eventIds = this.indexes.inverted.get(normalized) ?? new Set<string>();
      eventIds.add(event.id);
      this.indexes.inverted.set(normalized, eventIds);
    }
  }
}

function collectTerms(event: WebBlackboxEvent, maxTerms: number): string[] {
  const terms = new Set<string>();
  terms.add(event.type);

  collectFromValue(event.data, terms, maxTerms);

  return [...terms].slice(0, maxTerms);
}

function collectFromValue(value: unknown, terms: Set<string>, maxTerms: number): void {
  if (terms.size >= maxTerms) {
    return;
  }

  if (typeof value === "string") {
    tokenize(value, terms, maxTerms);
    return;
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (terms.size >= maxTerms) {
        return;
      }

      collectFromValue(entry, terms, maxTerms);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (terms.size >= maxTerms) {
        return;
      }

      tokenize(key, terms, maxTerms);
      collectFromValue(nested, terms, maxTerms);
    }
  }
}

function tokenize(value: string, terms: Set<string>, maxTerms: number): void {
  const parts = value.split(/[^a-zA-Z0-9_:.\-/]+/g).filter(Boolean);

  for (const part of parts) {
    if (terms.size >= maxTerms) {
      return;
    }

    terms.add(part);
  }
}

function shouldIndexTerm(term: string): boolean {
  if (term.length < MIN_INDEX_TERM_LENGTH || term.length > MAX_INDEX_TERM_LENGTH) {
    return false;
  }

  if (HASH_HEX_PATTERN.test(term)) {
    return false;
  }

  if (BASE64ISH_PATTERN.test(term)) {
    return false;
  }

  return true;
}
