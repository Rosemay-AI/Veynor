import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import { DiscordVoiceTransport } from "@veynor/transport-discord";
import { DefaultAudioSession, type AudioFrame } from "@veynor/core";
import { registerSkill, SkillRuntime, skills } from "@veynor/skill-sdk";
import { EchoSkill } from "./EchoSkill.js";

const TOKEN = process.env["DISCORD_BOT_TOKEN"] || "";
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
  requireEnv(["DISCORD_BOT_TOKEN"]);

  registerSkill(new EchoSkill());

  const transport = new DiscordVoiceTransport({
    token: TOKEN,
    guildId: GUILD,
    channelName: CHANNEL,
  });

  const session = new DefaultAudioSession({ silenceMs: 1500 });
  const runtime = new SkillRuntime(skills, "echo");

  session.onUtterance(async (utterance) => {
    console.log("[Echo] utterance from " + utterance.speakerId.slice(-6));
    const frames: AudioFrame[] = [];
    for await (const frame of runtime.processUtterance(utterance)) {
      frames.push(frame);
    }

    if (frames.length === 0) return;

    await transport.output(
      (async function* () {
        for (const f of frames) yield f;
      })()
    );
  });

  await transport.connect();

  for await (const frame of transport.input()) {
    session.push(frame);
  }
}

main().catch((e) => {
  console.error("[Echo] FATAL:", e);
  process.exit(1);
});