export interface AudioFrame {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  timestamp: number;
  speakerId?: string;
  data: Buffer;
}