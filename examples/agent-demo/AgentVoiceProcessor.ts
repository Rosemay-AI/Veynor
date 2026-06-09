import type { AudioFrame, VoiceProcessor, Utterance } from "@veynor/core";
import type { STTService, STTResult } from "./GroqSTTService.js";
import type { AgentService, AgentResult } from "./MiniMaxAgentService.js";
import type { TTSService } from "./MiniMaxTTSService.js";

export class AgentVoiceProcessor implements VoiceProcessor {
  readonly id = "agent";
  readonly name = "Agent (Groq + MiniMax)";

  private stt: STTService;
  private agent: AgentService;
  private tts: TTSService;
  private processing = false;

  constructor(
    stt: STTService,
    agent: AgentService,
    tts: TTSService
  ) {
    this.stt = stt;
    this.agent = agent;
    this.tts = tts;
  }

  async *processUtterance(utterance: Utterance): AsyncIterable<AudioFrame> {
    if (this.processing) return;
    this.processing = true;

    try {
      const frames: AudioFrame[] = [];
      if (!utterance.audio) return;
      for await (const f of utterance.audio) {
        frames.push(f);
      }

      console.log(
        "[Agent] STT: " + frames.length + " frames, " +
          (frames.reduce((s, f) => s + f.data.length, 0) / 192000).toFixed(2) + "s"
      );

      if (frames.length === 0) return;

      let sttResult: STTResult;
      try {
        sttResult = await this.stt.transcribe(frames);
      } catch (e: any) {
        console.error("[Agent] STT error:", e.message);
        return;
      }

      if (!sttResult.text) {
        console.log("[Agent] STT: (silent)");
        return;
      }

      console.log(
        "[Agent] STT → " + sttResult.text + " (" + sttResult.durationMs + "ms)"
      );

      let agentResult: AgentResult;
      try {
        agentResult = await this.agent.chat(sttResult.text);
      } catch (e: any) {
        console.error("[Agent] LLM error:", e.message);
        return;
      }

      console.log(
        "[Agent] LLM → " + agentResult.reply + " (" + agentResult.durationMs + "ms)"
      );

      let audioFrames: AudioFrame[];
      try {
        audioFrames = await this.tts.synthesize(agentResult.reply);
      } catch (e: any) {
        console.error("[Agent] TTS error:", e.message);
        return;
      }

      const dur = audioFrames.reduce((s, f) => s + f.data.length, 0) / 192000;
      console.log("[Agent] TTS: " + audioFrames.length + " frames, " + dur.toFixed(2) + "s");

      for (const frame of audioFrames) {
        yield frame;
      }
    } finally {
      this.processing = false;
    }
  }
}
