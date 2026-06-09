export enum TurnState {
  CREATED = "created",
  LISTENING = "listening",
  TRANSCRIBING = "transcribing",
  THINKING = "thinking",
  SPEAKING = "speaking",
  INTERRUPTED = "interrupted",
  COMPLETED = "completed",
  FAILED = "failed",
}

export type ParticipantId = string;
