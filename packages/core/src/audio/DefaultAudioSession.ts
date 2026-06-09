import type { AudioFrame } from "./AudioFrame.js";
import type { AudioSession as AudioSessionInterface, UtteranceHandler } from "./AudioSession.js";
import type { Utterance } from "./Utterance.js";

const DEFAULT_SILENCE_MS = 1500;

export class DefaultAudioSession implements AudioSessionInterface {
  private frames: AudioFrame[] = [];
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Set<UtteranceHandler>();
  private silenceMs: number;
  // Re-entrancy guard: silence-timer callback and flush() can both
  // invoke emitUtterance() and race at the early-return check. This
  // mutex makes the body run at most once per "emission window", so
  // a concurrent caller bails instead of seeing frames mid-clear.
  private _emitting = false;

  constructor(options?: { silenceMs?: number }) {
    this.silenceMs = options?.silenceMs ?? DEFAULT_SILENCE_MS;
  }

  push(frame: AudioFrame): void {
    this.frames.push(frame);
    this.resetTimer();
  }

  async flush(): Promise<void> {
    if (this.frames.length === 0) return;
    await this.emitUtterance();
  }

  onUtterance(handler: UtteranceHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private resetTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }
    this.silenceTimer = setTimeout(() => {
      this.emitUtterance().catch((e) => {
        console.error("[Veynor] AudioSession emit error:", e);
      });
    }, this.silenceMs);
  }

  private async emitUtterance(): Promise<void> {
    if (this._emitting) return;
    if (this.frames.length === 0) {
      return;
    }
    this._emitting = true;
    try {
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }

      const snapshot = this.frames;
      this.frames = [];

      const speakerId = snapshot[0]?.speakerId ?? "unknown";

      const utterance: Utterance = {
        speakerId,
        timestamp: Date.now(),
        audio: (async function* () {
          for (const frame of snapshot) {
            yield frame;
          }
        })(),
      };

      const promises: Promise<void>[] = [];
      for (const handler of this.handlers) {
        promises.push(
          Promise.resolve(handler(utterance)).catch((e) => {
            console.error("[Veynor] AudioSession handler error:", e);
          })
        );
      }
      await Promise.all(promises);
    } finally {
      this._emitting = false;
    }
  }
}
