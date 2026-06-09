import { Skill, type SkillUtterance, type SkillContext } from "@veynor/skill-sdk";
import { GraphNode } from "./GraphNode.js";
import type { Port } from "./Port.js";
import type { Signal } from "./Signal.js";
import {
  audioSignal,
  isAudio,
  type AudioSignal,
} from "./Signal.js";

export class SkillBridge extends GraphNode {
  readonly id: string;
  readonly name: string;
  readonly ports: { readonly inputs: Port[]; readonly outputs: Port[] };

  private skill: Skill;

  constructor(skill: Skill) {
    super();
    this.skill = skill;
    this.id = `bridge-${skill.id}`;
    this.name = `Bridge(${skill.name})`;
    this.ports = {
      inputs: [
        {
          id: "audio_in",
          direction: "input",
          accepts: ["audio"],
          required: true,
          name: "Audio Input",
        },
      ],
      outputs: [
        {
          id: "audio_out",
          direction: "output",
          accepts: ["audio"],
          required: false,
          name: "Audio Output",
        },
      ],
    };
  }

  async *executeSignals(
    inputs: Signal[],
    ctx: SkillContext
  ): AsyncIterable<Signal> {
    const audioInputs = inputs.filter(isAudio);
    if (audioInputs.length === 0) return;

    const firstAudio = audioInputs[0] as AudioSignal;

    const skillUtterance: SkillUtterance = {
      speakerId: "graph",
      audio: () => {
        const payload = firstAudio.payload;
        if (Array.isArray(payload)) {
          return (async function* () {
            for (const f of payload) yield f;
          })();
        }
        return payload;
      },
    };

    for await (const frame of this.skill.execute(skillUtterance, ctx)) {
      yield audioSignal(this.id, [frame]);
    }
  }
}
