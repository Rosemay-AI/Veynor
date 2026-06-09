import type { VeynorSkillInternalOptions } from "./types.js";

export type LLMResponse = { text: string };

export type HermesAgentOptions = {
  id?: string;
  personality?: string;
  processText: (text: string, history: string[]) => Promise<LLMResponse>;
};

export class HermesAgent {
  readonly id: string;
  readonly personality: string;
  private processText: (text: string, history: string[]) => Promise<LLMResponse>;
  private history: string[] = [];
  private pendingPCMs: Buffer[] = [];

  constructor(options: HermesAgentOptions) {
    this.id = options.id ?? "hermes";
    this.personality =
      options.personality ??
      "You are Hermes, a helpful voice assistant. Keep responses concise and conversational.";
    this.processText = options.processText;
  }

  toSkillOptions(): VeynorSkillInternalOptions {
    return {
      id: this.id,
      onAudio: (pcm) => {
        this.pendingPCMs.push(pcm);
      },
      onText: () => this.generateResponse(),
    };
  }

  private async *generateResponse(): AsyncIterable<string> {
    const batch = this.pendingPCMs.splice(0);
    for (const pcm of batch) {
      const text = `[audio received, ${pcm.length} bytes]`;
      this.history.push(text);

      const response = await this.processText(text, this.history);
      this.history.push(response.text);

      yield response.text;
    }
  }
}
