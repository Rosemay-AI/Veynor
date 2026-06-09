import type { AudioFrame, VoiceProcessor, Utterance } from "@veynor/core";
import type { Skill, SkillUtterance, SkillContext } from "./Skill.js";

export type TranscriptHandler = (text: string) => void;

export class SkillAdapter implements VoiceProcessor {
  readonly id: string;
  readonly name: string;

  private skill: Skill;
  private onTranscript?: TranscriptHandler;
  private _externalSignal?: AbortSignal;

  constructor(skill: Skill, options?: { onTranscript?: TranscriptHandler; abortSignal?: AbortSignal }) {
    this.skill = skill;
    this.id = skill.id;
    this.name = skill.name;
    this.onTranscript = options?.onTranscript;
    this._externalSignal = options?.abortSignal;
  }

  async *processUtterance(utterance: Utterance): AsyncIterable<AudioFrame> {
    const ac = new AbortController();

    // Bridge external signal into our internal controller. The listener
    // is removed in `finally` even on natural completion; otherwise it
    // would stay attached to `_externalSignal` until the next abort or
    // GC, leaking across long-lived processors that reuse the same
    // external signal.
    let onAbort: (() => void) | undefined;
    if (this._externalSignal) {
      onAbort = () => ac.abort();
      this._externalSignal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const skillUtterance: SkillUtterance = {
        speakerId: utterance.speakerId,
        audio: utterance.audio
          ? () => utterance.audio!
          : () => (async function* () {})() as unknown as AsyncIterable<AudioFrame>,
      };

      const ctx: SkillContext = {
        say: (text: string) => this.onTranscript?.(text),
        abortSignal: ac.signal,
      };

      for await (const frame of this.skill.execute(skillUtterance, ctx)) {
        yield frame;
      }
    } finally {
      if (onAbort && this._externalSignal) {
        this._externalSignal.removeEventListener("abort", onAbort);
      }
    }
  }
}
