import https from "https";
import type { AudioFrame } from "@veynor/core";

export interface TTSService {
  synthesize(text: string): Promise<AudioFrame[]>;
}

export class MiniMaxTTSService implements TTSService {
  private apiKey: string;
  private model: string;

  constructor(options: { apiKey: string; model?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "speech-2.8-hd";
  }

  async synthesize(text: string): Promise<AudioFrame[]> {
    const pcm32k = await this.callTTS(text);
    return pcm32kToFrames48k(pcm32k);
  }

  private callTTS(text: string): Promise<Buffer> {
    const body = JSON.stringify({
      model: this.model,
      text,
      stream: false,
      voice_setting: {
        voice_id: "female-shaonv",
        speed: 1,
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "pcm",
        channel: 1,
      },
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "api.minimaxi.com",
          port: 443,
          path: "/v1/t2a_v2",
          method: "POST",
          headers: {
            "Authorization": "Bearer " + this.apiKey,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            try {
              const r = JSON.parse(buf.toString());
              if (
                r?.base_resp?.status_code &&
                r.base_resp.status_code !== 0
              ) {
                console.error("[TTS] FULL RESPONSE:");
                console.error(JSON.stringify(r, null, 2));
                reject(
                  new Error(
                    "MiniMax TTS API error: " +
                      JSON.stringify(r)
                  )
                );
                return;
              }
              const hexAudio = r?.data?.audio;
              if (!hexAudio) {
                reject(new Error("MiniMax TTS no audio field"));
                return;
              }
              resolve(Buffer.from(hexAudio, "hex"));
            } catch (e: any) {
              reject(
                new Error(
                  "MiniMax TTS parse: " +
                    e.message +
                    " | raw=" +
                    buf.toString().slice(0, 200)
                )
              );
            }
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

function pcm32kToFrames48k(pcm32k: Buffer): AudioFrame[] {
  const frameSize = 960;
  const inRatio = 32000 / 48000;
  const bytesPerFrameOut = frameSize * 2 * 2;
  const frames: AudioFrame[] = [];
  let srcSample = 0;

  while ((srcSample + 1) * 2 <= pcm32k.length) {
    const frame = Buffer.alloc(bytesPerFrameOut);
    for (let i = 0; i < frameSize; i++) {
      const srcIdx = Math.min(srcSample + Math.floor(i * inRatio), Math.floor((pcm32k.length - 2) / 2));
      const sample = pcm32k.readInt16LE(srcIdx * 2);
      frame.writeInt16LE(sample, i * 4);
      frame.writeInt16LE(sample, i * 4 + 2);
    }

    srcSample += Math.floor(frameSize * inRatio);
    if (srcSample * 2 > pcm32k.length) break;

    frames.push({
      sampleRate: 48000,
      channels: 2,
      bitDepth: 16,
      timestamp: Date.now(),
      data: frame,
    });
  }
  return frames;
}
