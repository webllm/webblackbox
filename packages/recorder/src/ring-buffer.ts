import type { WebBlackboxEvent } from "@webblackbox/protocol";

const COMPACT_REMOVED_THRESHOLD = 2_048;

export class EventRingBuffer {
  private readonly events: WebBlackboxEvent[] = [];
  private startIndex = 0;

  private readonly maxWindowMs: number;

  public constructor(minutes: number) {
    this.maxWindowMs = minutes * 60 * 1000;
  }

  public push(event: WebBlackboxEvent): void {
    this.events.push(event);
    this.prune(event.t);
  }

  public snapshot(): WebBlackboxEvent[] {
    return this.startIndex === 0 ? [...this.events] : this.events.slice(this.startIndex);
  }

  public size(): number {
    return this.events.length - this.startIndex;
  }

  public clear(): void {
    this.events.length = 0;
    this.startIndex = 0;
  }

  private prune(currentTime: number): void {
    const threshold = currentTime - this.maxWindowMs;

    while (this.startIndex < this.events.length) {
      const candidate = this.events[this.startIndex];

      if (!candidate || candidate.t >= threshold) {
        break;
      }

      this.startIndex += 1;
    }

    if (this.startIndex >= COMPACT_REMOVED_THRESHOLD && this.startIndex * 2 >= this.events.length) {
      this.compact();
    }
  }

  private compact(): void {
    if (this.startIndex === 0) {
      return;
    }

    this.events.splice(0, this.startIndex);
    this.startIndex = 0;
  }
}
