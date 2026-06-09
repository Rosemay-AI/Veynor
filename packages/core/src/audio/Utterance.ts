import type { AudioFrame } from "./AudioFrame.js";

export interface Utterance {
  speakerId: string;

  text?: string;

  audio?: AsyncIterable<AudioFrame>;

  metadata?: Record<string, unknown>;

  timestamp: number;
}