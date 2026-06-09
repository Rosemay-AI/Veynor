import type { AudioFrame } from "@veynor/core";
import {
  Skill,
  type SkillUtterance,
  type SkillContext,
  type PipelineContext,
} from "@veynor/skill-sdk";

const SAMPLE_RATE = 24000;
const TONE_HZ = 440;

export class HermesTTS extends Skill {
  readonly id = "hermes-tts";
  readonly name = "Hermes TTS";

  async *execute(
    _utterance: SkillUtterance,
    ctx: SkillContext
  ): AsyncIterable<AudioFrame> {
    const transcript = (ctx as PipelineContext).transcript ?? "";
    if (!transcript) return;

    const durationMs = Math.min(transcript.length * 80, 5000);
    const samples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
    const buf = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
      const t = i / SAMPLE_RATE;
      const sample = Math.sin(2 * Math.PI * TONE_HZ * t) * 0.3;
      const int16 = Math.round(sample * 32767);
      buf.writeInt16LE(int16, i * 2);
    }

    const frameSize = Math.floor(SAMPLE_RATE * 0.02);
    for (let offset = 0; offset < buf.length; offset += frameSize * 2) {
      const chunk = buf.subarray(offset, offset + frameSize * 2);
      yield {
        sampleRate: SAMPLE_RATE,
        channels: 1,
        bitDepth: 16,
        timestamp: Date.now(),
        data: chunk,
      };
    }
  }
}
