import type { AudioPacket } from "../audio/AudioPacket.js";
import type { AudioFrame } from "../audio/AudioFrame.js";

export interface AudioCodec {
  encode(
    frames: AsyncIterable<AudioFrame>
  ): AsyncIterable<AudioPacket>;

  decode(
    packets: AsyncIterable<AudioPacket>
  ): AsyncIterable<AudioFrame>;
}