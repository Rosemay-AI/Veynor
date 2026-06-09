import type { AudioFrame } from "../audio/AudioFrame.js";

export interface AudioTransport {
  connect(): Promise<void>;

  disconnect(): Promise<void>;

  input(): AsyncIterable<AudioFrame>;

  output(
    frames: AsyncIterable<AudioFrame>
  ): Promise<void>;
}