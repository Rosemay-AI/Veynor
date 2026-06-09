import type { AudioFrame } from "@veynor/core";
import { TurnState } from "@veynor/core";
import type { OpenClawRuntimeSession } from "./OpenClawRuntime.js";

export class OpenClawTurn {
  readonly id: string;
  state: TurnState = TurnState.CREATED;
  userText = "";
  assistantText = "";
  private unsubAudio: (() => void) | null = null;
  private unsubTranscript: (() => void) | null = null;
  private closed = false;
  private audioListeners: Array<(frame: AudioFrame) => void> = [];
  private transcriptListeners: Array<(text: string) => void> = [];
  private abortController = new AbortController();

  constructor(
    id: string,
    private runtimeSession: OpenClawRuntimeSession
  ) {
    this.id = id;

    this.unsubAudio = this.runtimeSession.onAudio((frame) => {
      if (!this.closed) {
        for (const cb of this.audioListeners) cb(frame);
      }
    });

    this.unsubTranscript = this.runtimeSession.onTranscript((text) => {
      if (!this.closed) {
        for (const cb of this.transcriptListeners) cb(text);
      }
    });
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  onAudio(cb: (frame: AudioFrame) => void): () => void {
    this.audioListeners.push(cb);
    return () => {
      const i = this.audioListeners.indexOf(cb);
      if (i >= 0) this.audioListeners.splice(i, 1);
    };
  }

  onTranscript(cb: (text: string) => void): () => void {
    this.transcriptListeners.push(cb);
    return () => {
      const i = this.transcriptListeners.indexOf(cb);
      if (i >= 0) this.transcriptListeners.splice(i, 1);
    };
  }

  pushAudio(frame: AudioFrame): void {
    this.runtimeSession.pushAudio(frame);
  }

  finishAudio(): void {
    this.state = TurnState.TRANSCRIBING;
    this.runtimeSession.endTurn();
  }

  interrupt(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.isTerminal()) return;
    this.state = TurnState.INTERRUPTED;
    this.abortController.abort();
    this.runtimeSession.interrupt();
    this.cleanup();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.isTerminal()) return;
    this.state = TurnState.COMPLETED;
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    this.runtimeSession.close();
    this.cleanup();
  }

  private isTerminal(): boolean {
    return (
      this.state === TurnState.COMPLETED ||
      this.state === TurnState.FAILED ||
      this.state === TurnState.INTERRUPTED
    );
  }

  private cleanup(): void {
    this.unsubAudio?.();
    this.unsubTranscript?.();
    this.unsubAudio = null;
    this.unsubTranscript = null;
    this.audioListeners = [];
    this.transcriptListeners = [];
  }
}
