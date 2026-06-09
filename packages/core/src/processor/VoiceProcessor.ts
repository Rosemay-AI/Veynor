import type { AudioFrame } from "../audio/AudioFrame.js";
import type { Utterance } from "../audio/Utterance.js";

export interface VoiceProcessor {
  readonly id: string;
  readonly name: string;

  processUtterance(utterance: Utterance): AsyncIterable<AudioFrame>;
}
