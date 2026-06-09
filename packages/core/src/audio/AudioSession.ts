import type { AudioFrame } from "../audio/AudioFrame.js";
import type { Utterance } from "../audio/Utterance.js";

export type UtteranceHandler = (utterance: Utterance) => void | Promise<void>;

export interface AudioSession {
  push(frame: AudioFrame): void;

  flush(): Promise<void>;

  onUtterance(handler: UtteranceHandler): () => void;
}