import type { AudioFrame, VoiceProcessor, Utterance } from "@veynor/core";

export class EchoVoiceProcessor implements VoiceProcessor {
  readonly id = "echo";
  readonly name = "Echo";

  async *processUtterance(utterance: Utterance): AsyncIterable<AudioFrame> {
    if (!utterance.audio) return;
    for await (const frame of utterance.audio) {
      yield frame;
    }
  }
}
