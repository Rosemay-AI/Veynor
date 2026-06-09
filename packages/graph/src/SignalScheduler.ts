import type { Signal } from "./Signal.js";

export class SignalScheduler {
  private queue: Signal[] = [];
  private processed = new Set<string>();

  enqueue(signal: Signal): void {
    this.queue.push(signal);
  }

  enqueueAll(signals: Signal[]): void {
    for (const s of signals) this.enqueue(s);
  }

  dequeue(): Signal | undefined {
    return this.queue.shift();
  }

  get pending(): number {
    return this.queue.length;
  }
}
