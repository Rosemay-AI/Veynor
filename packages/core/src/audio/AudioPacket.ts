export type AudioCodecType =
  | "opus"
  | "pcm16"
  | "pcm24"
  | "pcm32"
  | "mulaw"
  | "alaw";

export interface AudioPacket {
  codec: AudioCodecType;
  timestamp: number;
  payload: Uint8Array;
}