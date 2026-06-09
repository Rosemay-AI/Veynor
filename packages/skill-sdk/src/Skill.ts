import type { AudioFrame } from "@veynor/core";

export interface SkillUtterance {
  readonly speakerId: string;
  audio(): AsyncIterable<AudioFrame>;
}

export interface SkillContext {
  say(text: string): void;
  readonly abortSignal: AbortSignal;
}

export abstract class Skill {
  abstract readonly id: string;
  abstract readonly name: string;

  abstract execute(
    utterance: SkillUtterance,
    ctx: SkillContext
  ): AsyncIterable<AudioFrame>;
}
