import type { AudioFrame } from "@veynor/core";
import {
  Skill,
  type SkillUtterance,
  type SkillContext,
} from "@veynor/skill-sdk";
import type { Signal } from "./Signal.js";
import { audioSignal, isAudio } from "./Signal.js";

export class ExecutionKernel {
  private skill: Skill;

  constructor(skill: Skill) {
    this.skill = skill;
  }

  async *execute(
    utterance: SkillUtterance,
    ctx: SkillContext
  ): AsyncIterable<AudioFrame> {
    for await (const frame of this.skill.execute(utterance, ctx)) {
      yield frame;
    }
  }

  async *runSignal(
    input: Signal,
    ctx: SkillContext
  ): AsyncIterable<Signal> {
    if ("run" in this.skill) {
      yield* (this.skill as Skill & { run(s: Signal, c: SkillContext): AsyncIterable<Signal> }).run(input, ctx);
      return;
    }

    const utterance: SkillUtterance = {
      speakerId: input.sourceNodeId,
      audio: () => {
        if (!isAudio(input)) return (async function* () {})();
        const audio = input.payload;
        if (Array.isArray(audio)) {
          return (async function* () {
            for (const f of audio) yield f;
          })();
        }
        return audio;
      },
    };

    for await (const frame of this.skill.execute(utterance, ctx)) {
      yield audioSignal(this.skill.id, [frame]);
    }
  }
}
