import type { AudioFrame } from "@veynor/core";

export interface OpenClawRuntimeSession {
  pushAudio(frame: AudioFrame): void;

  onAudio(cb: (frame: AudioFrame) => void): () => void;
  onTranscript(cb: (text: string) => void): () => void;

  startTurn(): void;
  endTurn(): void;

  interrupt(): void;
  close(): void;
}

export interface OpenClawRuntime {
  createSession(): OpenClawRuntimeSession;
}
