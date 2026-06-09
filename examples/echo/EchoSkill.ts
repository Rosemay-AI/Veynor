import type { AudioFrame } from "@veynor/core";
import { Skill, type SkillUtterance, type SkillContext } from "@veynor/skill-sdk";

export class EchoSkill extends Skill {
  readonly id = "echo";
  readonly name = "Echo";

  async *execute(
    utterance: SkillUtterance,
    _ctx: SkillContext
  ): AsyncIterable<AudioFrame> {
    for await (const frame of utterance.audio()) {
      yield frame;
    }
  }
}
