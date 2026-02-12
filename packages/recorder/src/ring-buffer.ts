import type { WebBlackboxEvent } from "@webblackbox/protocol";

export class EventRingBuffer {
  private readonly events: WebBlackboxEvent[] = [];

  private readonly maxWindowMs: number;

  public constructor(minutes: number) {
    this.maxWindowMs = minutes * 60 * 1000;
  }

  public push(event: WebBlackboxEvent): void {
    this.events.push(event);
    this.prune(event.t);
  }

  public snapshot(): WebBlackboxEvent[] {
    return [...this.events];
  }

  public size(): number {
    return this.events.length;
  }

  public clear(): void {
    this.events.length = 0;
  }

  private prune(currentTime: number): void {
    const threshold = currentTime - this.maxWindowMs;

    let index = 0;

    while (index < this.events.length) {
      const candidate = this.events[index];

      if (!candidate || candidate.t >= threshold) {
        break;
      }

      index += 1;
    }

    if (index > 0) {
      this.events.splice(0, index);
    }
  }
}
