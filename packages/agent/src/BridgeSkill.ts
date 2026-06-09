import type { AudioFrame } from "@veynor/core";
import {
  Skill,
  type SkillUtterance,
  type SkillContext,
} from "@veynor/skill-sdk";
import type { VeynorSkillInternalOptions } from "./types.js";

export class BridgeSkill extends Skill {
  readonly id: string;
  readonly name: string;
  private onAudio?: (pcm: Buffer) => void;
  private onText?: () => AsyncIterable<string>;

  constructor(options: VeynorSkillInternalOptions) {
    super();
    this.id = options.id;
    this.name = `Bridge[${options.id}]`;
    this.onAudio = options.onAudio;
    this.onText = options.onText;
  }

  async *execute(
    utterance: SkillUtterance,
    ctx: SkillContext
  ): AsyncIterable<AudioFrame> {
    const pcm = await this.collectAudio(utterance);
    if (ctx.abortSignal.aborted) return;

    // Skip empty buffers (utterance.audio() produced no frames) so
    // downstream consumers like HermesAgent don't get a 0-byte entry
    // polluting their queue.
    if (pcm.length > 0) {
      this.onAudio?.(pcm);
    }

    const textStream = this.onText;
    if (!textStream) return;

    try {
      for await (const text of textStream()) {
        if (ctx.abortSignal.aborted) break;
        ctx.say(text);
      }
    } catch (e) {
      console.error(`[BridgeSkill:${this.id}] error:`, e);
    }
  }

  private async collectAudio(utterance: SkillUtterance): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const frame of utterance.audio()) {
      chunks.push(frame.data);
    }
    return Buffer.concat(chunks);
  }
}
