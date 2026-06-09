import type { AudioFrame, Utterance, VoiceProcessor } from "@veynor/core";
import type { Skill } from "./Skill.js";
import { SkillAdapter, type TranscriptHandler } from "./SkillAdapter.js";
import type { SkillRegistry } from "./SkillRegistry.js";

export type SkillRuntimeOptions = {
  onTranscript?: TranscriptHandler;
};

export class SkillRuntime {
  readonly registry: SkillRegistry;
  private _activeId: string;
  private onTranscript?: TranscriptHandler;

  constructor(
    registry: SkillRegistry,
    initialSkillId: string,
    options?: SkillRuntimeOptions
  ) {
    if (!registry.has(initialSkillId)) {
      throw new Error(
        `Skill "${initialSkillId}" is not registered. ` +
          `Available: [${registry.ids().join(", ") || "none"}]`
      );
    }
    this.registry = registry;
    this._activeId = initialSkillId;
    this.onTranscript = options?.onTranscript;
  }

  get activeId(): string {
    return this._activeId;
  }

  get active(): Skill | undefined {
    return this.registry.get(this._activeId);
  }

  switchTo(skillId: string): void {
    if (!this.registry.has(skillId)) {
      throw new Error(
        `Skill "${skillId}" is not registered. ` +
          `Available: [${this.registry.ids().join(", ") || "none"}]`
      );
    }
    this._activeId = skillId;
  }

  createProcessor(options?: { abortSignal?: AbortSignal }): VoiceProcessor | undefined {
    const skill = this.active;
    if (!skill) return undefined;
    return new SkillAdapter(skill, {
      onTranscript: this.onTranscript,
      abortSignal: options?.abortSignal,
    });
  }

  async *processUtterance(utterance: Utterance, abortSignal?: AbortSignal): AsyncIterable<AudioFrame> {
    const skill = this.active;
    if (!skill) return;
    const processor = new SkillAdapter(skill, { onTranscript: this.onTranscript, abortSignal });
    yield* processor.processUtterance(utterance);
  }
}