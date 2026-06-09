import type { AudioFrame, VoiceProcessor, Utterance } from "@veynor/core";
import type { OpenClawSession } from "./OpenClawSession.js";

export class SessionVoiceProcessor implements VoiceProcessor {
  readonly id = "session";
  readonly name = "Voice Session";

  private session: OpenClawSession;

  constructor(session: OpenClawSession) {
    this.session = session;
  }

  async *processUtterance(utterance: Utterance): AsyncIterable<AudioFrame> {
    const turn = this.session.startTurn();
    const outputFrames: AudioFrame[] = [];

    const unsub = turn.onAudio((frame) => {
      outputFrames.push(frame);
    });

    try {
      if (utterance.audio) {
        for await (const frame of utterance.audio) {
          turn.pushAudio(frame);
        }
      }
      turn.finishAudio();
    } finally {
      unsub();
      if (turn.state === "completed" || turn.state === "interrupted") {
        // turn already finished
      } else {
        turn.close();
      }
    }

    for (const frame of outputFrames) {
      yield frame;
    }
  }
}
