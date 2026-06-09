import type { AudioFrame, ParticipantId, TurnState, VoiceTurnContext } from "@veynor/core";

export type { AudioFrame, ParticipantId, TurnState, VoiceTurnContext };

export interface Agent {
  chat(text: string, participantId: ParticipantId, signal?: AbortSignal): Promise<string>;
}

export type VoiceConnectConfig = {
  token: string;
  guildId: string;
  channelName: string;
};

export type VeynorSkillInternalOptions = {
  id: string;
  onAudio?: (pcm: Buffer) => void;
  onText?: () => AsyncIterable<string>;
};
