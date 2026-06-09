import https from "https";
import FormData from "form-data";
import type { AudioFrame } from "@veynor/core";

export interface STTResult {
  text: string;
  durationMs: number;
}

export interface STTService {
  transcribe(frames: AudioFrame[]): Promise<STTResult>;
}

function resample48kStereoTo16kMono(frames: AudioFrame[]): Buffer {
  const totalStereoBytes = frames.reduce((s, f) => s + f.data.length, 0);
  const stereoBuf = Buffer.concat(frames.map((f) => f.data));

  const samples48k = Math.floor(totalStereoBytes / 4);
  const mono16kLen = Math.floor(samples48k * 16000 / 48000);
  const out = Buffer.alloc(mono16kLen * 2);
  let outIdx = 0;
  const ratio = 48000 / 16000;

  for (let i = 0; i < mono16kLen; i++) {
    const srcIdx = Math.floor(i * ratio);
    const byteOff = srcIdx * 4;
    const left = stereoBuf.readInt16LE(byteOff);
    const right = stereoBuf.readInt16LE(byteOff + 2);
    const mono = Math.round((left + right) / 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, mono)), outIdx);
    outIdx += 2;
  }

  return out;
}

function buildWav(pcm16kMono: Buffer): Buffer {
  const dataLen = pcm16kMono.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm16kMono]);
}

export class GroqSTTService implements STTService {
  private apiKey: string;
  private model: string;

  constructor(options: { apiKey: string; model?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "whisper-large-v3";
  }

  async transcribe(frames: AudioFrame[]): Promise<STTResult> {
    const start = Date.now();

    const pcm16kMono = resample48kStereoTo16kMono(frames);
    const wav = buildWav(pcm16kMono);

    const form = new FormData();
    form.append("file", wav, { filename: "audio.wav", contentType: "audio/wav" });
    form.append("model", this.model);
    form.append("language", "zh");
    form.append("response_format", "verbose_json");

    const headers = {
      ...form.getHeaders(),
      "Authorization": "Bearer " + this.apiKey,
    };

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.groq.com",
        port: 443,
        path: "/openai/v1/audio/transcriptions",
        method: "POST",
        headers,
      }, (res) => {
        let d = "";
        res.on("data", (c) => d += c);
        res.on("end", () => {
          try {
            const json = JSON.parse(d);
            if (json.text && json.text.trim()) {
              const text = json.text.trim();
              const durationMs = Date.now() - start;
              resolve({ text, durationMs });
            } else {
              resolve({ text: "", durationMs: Date.now() - start });
            }
          } catch {
            resolve({ text: "", durationMs: Date.now() - start });
          }
        });
      });
      req.on("error", reject);
      form.pipe(req);
    });
  }
}
