import type { TurnState } from "./VoiceTurn.js";

export interface VoiceTurnContext {
  readonly id: number;
  readonly signal: AbortSignal;
  state: TurnState;
  userText: string;
  assistantText: string;
  interrupt(): void;
}
