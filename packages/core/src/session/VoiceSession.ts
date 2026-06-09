import type { ParticipantId } from "./VoiceTurn.js";
import type { VoiceTurnContext } from "./VoiceTurnContext.js";

export interface SessionStrategy {
  buildSessionKey(participantId: ParticipantId): string;
}

export interface VoiceSession {
  getActiveTurn(): VoiceTurnContext | null;
  startTurn(): VoiceTurnContext;
  cancelTurn(): void;
}
