import type { AudioFrame } from "@veynor/core";
import { Skill, type SkillUtterance, type SkillContext } from "./Skill.js";

export interface PipelineContext extends SkillContext {
  readonly transcript: string;
}

export interface SkillStep {
  readonly id: string;
  readonly skill: Skill;
  readonly name?: string;
}

export class SkillPipeline extends Skill {
  readonly id: string;
  readonly name: string;
  readonly steps: SkillStep[];

  constructor(id: string, steps: SkillStep[]) {
    super();
    this.id = id;
    this.steps = steps;
    this.name = `Pipeline[${steps.map((s) => s.id).join("\u2192")}]`;
  }

  async *execute(
    utterance: SkillUtterance,
    outerCtx: SkillContext
  ): AsyncIterable<AudioFrame> {
    if (this.steps.length === 0) return;

    let currentAudio = utterance.audio();
    let transcript = "";

    for (let i = 0; i < this.steps.length; i++) {
      if (outerCtx.abortSignal.aborted) break;

      const step = this.steps[i];
      const isLast = i === this.steps.length - 1;

      const capturedTranscript = transcript;

      const stepCtx: PipelineContext = {
        get transcript() {
          return capturedTranscript;
        },
        say: (text: string) => {
          transcript = text;
          outerCtx.say(text);
        },
        abortSignal: outerCtx.abortSignal,
      };

      const stepUtterance: SkillUtterance = {
        speakerId: utterance.speakerId,
        audio: () => currentAudio,
      };

      const output: AudioFrame[] = [];
      for await (const frame of step.skill.execute(stepUtterance, stepCtx)) {
        output.push(frame);
      }

      if (output.length > 0) {
        currentAudio = (async function* () {
          for (const f of output) yield f;
        })();
      }

      if (isLast) {
        for (const f of output) yield f;
      }
    }
  }
}

export function pipe(steps: Skill[]): SkillPipeline {
  return new SkillPipeline(
    `pipeline-${steps.map((s) => s.id).join("-")}`,
    steps.map((s) => ({ id: s.id, skill: s, name: s.name }))
  );
}

export function compose(
  id: string,
  steps: SkillStep[]
): SkillPipeline {
  return new SkillPipeline(id, steps);
}

export function step(
  skill: Skill,
  overrides?: { id?: string; name?: string }
): SkillStep {
  return {
    id: overrides?.id ?? skill.id,
    skill,
    name: overrides?.name ?? skill.name,
  };
}
