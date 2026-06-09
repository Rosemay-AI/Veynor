import type { AudioFrame } from "../audio/AudioFrame.js";

export class FrameQueue implements AsyncIterable<AudioFrame> {
  private buffer: AudioFrame[] = [];
  private waiters: Array<(result: IteratorResult<AudioFrame>) => void> = [];
  private closed = false;

  push(frame: AudioFrame): void {
    if (this.closed) return;
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter) waiter({ value: frame, done: false });
    } else {
      this.buffer.push(frame);
    }
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter) waiter({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AudioFrame> {
    const self = this;
    return {
      async next(): Promise<IteratorResult<AudioFrame>> {
        if (self.closed && self.buffer.length === 0) {
          return { value: undefined as any, done: true };
        }
        if (self.buffer.length > 0) {
          return { value: self.buffer.shift()!, done: false };
        }
        return new Promise((resolve) => {
          self.waiters.push(resolve);
        });
      },
      async return(): Promise<IteratorResult<AudioFrame>> {
        self.close();
        return { value: undefined as any, done: true };
      },
    };
  }
}
