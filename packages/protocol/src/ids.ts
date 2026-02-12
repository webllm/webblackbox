const SESSION_PREFIX = "S";
const EVENT_PREFIX = "E";
const ACTION_PREFIX = "A";
const CHUNK_PREFIX = "C";

function randomToken(length = 8): string {
  return Math.random()
    .toString(36)
    .slice(2, 2 + length);
}

function padNumber(value: number, size = 8): string {
  return `${value}`.padStart(size, "0");
}

export function createSessionId(timestamp = Date.now()): string {
  return `${SESSION_PREFIX}-${timestamp}-${randomToken(10)}`;
}

export function createActionId(sequence: number): string {
  return `${ACTION_PREFIX}-${padNumber(sequence, 6)}`;
}

export function createChunkId(sequence: number): string {
  return `${CHUNK_PREFIX}-${padNumber(sequence, 6)}`;
}

export class EventIdFactory {
  private sequence = 0;

  public next(): string {
    this.sequence += 1;
    return `${EVENT_PREFIX}-${padNumber(this.sequence, 8)}`;
  }

  public value(): number {
    return this.sequence;
  }
}
