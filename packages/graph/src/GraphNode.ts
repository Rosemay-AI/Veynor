import type { AudioFrame } from "@veynor/core";
import {
  Skill,
  type SkillUtterance,
  type SkillContext,
} from "@veynor/skill-sdk";
import type { Port } from "./Port.js";
import type { Signal } from "./Signal.js";
import { audioSignal, isAudio } from "./Signal.js";

export abstract class GraphNode extends Skill {
  abstract readonly ports: {
    readonly inputs: Port[];
    readonly outputs: Port[];
  };

  abstract executeSignals(
    inputs: Signal[],
    ctx: SkillContext
  ): AsyncIterable<Signal>;

  async *execute(
    utterance: SkillUtterance,
    ctx: SkillContext
  ): AsyncIterable<AudioFrame> {
    const inputSignal = audioSignal(this.id, utterance.audio());

    for await (const signal of this.executeSignals([inputSignal], ctx)) {
      if (!isAudio(signal)) continue;

      const audio = signal.payload;
      if (Array.isArray(audio)) {
        for (const frame of audio) yield frame;
      } else {
        yield* audio;
      }
    }
  }
}
