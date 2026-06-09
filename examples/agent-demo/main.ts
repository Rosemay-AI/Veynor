import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import { DiscordVoiceTransport } from "@veynor/transport-discord";
import { DefaultAudioSession, type AudioFrame } from "@veynor/core";
import { registerSkill, SkillRuntime, skills } from "@veynor/skill-sdk";
import { GroqSTTService } from "./GroqSTTService.js";
import { MiniMaxAgentService } from "./MiniMaxAgentService.js";
import { MiniMaxTTSService } from "./MiniMaxTTSService.js";
import { AgentSkill } from "./AgentSkill.js";

const DISCORD_TOKEN = process.env["DISCORD_BOT_TOKEN"] || "";
const GROQ_API_KEY = process.env["GROQ_API_KEY"] || "";
const MINIMAX_API_KEY = process.env["MINIMAX_API_KEY"] || "";
const MINIMAX_MODEL = process.env["MINIMAX_MODEL"] || "speech-2.8-hd";
const MINIMAX_LLM_MODEL = process.env["MINIMAX_LLM_MODEL"] || "MiniMax-M3";
const GUILD = "937987051360485416";
const CHANNEL = "新人接待大厅";

function requireEnv(keys: string[]): void {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required env: ${missing.join(", ")}`);
    process.exit(1);
  }
}

async function main() {
  requireEnv(["DISCORD_BOT_TOKEN", "GROQ_API_KEY", "MINIMAX_API_KEY"]);

  const transport = new DiscordVoiceTransport({
    token: DISCORD_TOKEN,
    guildId: GUILD,
    channelName: CHANNEL,
  });

  const session = new DefaultAudioSession({ silenceMs: 1500 });

  const stt = new GroqSTTService({ apiKey: GROQ_API_KEY });
  const llm = new MiniMaxAgentService({
    apiKey: MINIMAX_API_KEY,
    model: MINIMAX_LLM_MODEL,
  });
  const tts = new MiniMaxTTSService({
    apiKey: MINIMAX_API_KEY,
    model: MINIMAX_MODEL,
  });

  registerSkill(new AgentSkill(stt, llm, tts));

  const runtime = new SkillRuntime(skills, "agent", {
    onTranscript: (text) => console.log(`[Agent] transcript: ${text}`),
  });

  session.onUtterance(async (utterance) => {
    const ttsFrames: AudioFrame[] = [];
    for await (const frame of runtime.processUtterance(utterance)) {
      ttsFrames.push(frame);
    }

    if (ttsFrames.length === 0) return;

    await transport.output(
      (async function* () {
        for (const f of ttsFrames) yield f;
      })()
    );
  });

  await transport.connect();

  for await (const frame of transport.input()) {
    session.push(frame);
  }
}

main().catch((e) => {
  console.error("[Agent] FATAL:", e);
  process.exit(1);
});
