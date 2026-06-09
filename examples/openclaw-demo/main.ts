import { execFile } from "child_process";
import { existsSync } from "fs";
import { createInterface } from "readline";
import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import { VeynorSkill, type Agent, type ParticipantId } from "@veynor/agent";

const TOKEN = process.env["DISCORD_BOT_TOKEN"] || "";
const GUILD = process.env["GUILD_ID"] || "your-guild-id-here";
const CHANNEL = process.env["VOICE_CHANNEL_NAME"] || "General";

const OPENCLAW_MJS =
  process.env["OPENCLAW_MJS"] ||
  "D:\\npm-global\\node_modules\\openclaw\\openclaw.mjs";

function requireEnv(keys: string[]): void {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required env: ${missing.join(", ")}`);
    process.exit(1);
  }
}

function sessionKey(participantId: ParticipantId): string {
  return `session:${GUILD}:${participantId}`;
}

function openclawChat(text: string, participantId: ParticipantId, signal?: AbortSignal): Promise<string> {
  const key = sessionKey(participantId);
  const voicePrefix = "";

  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = execFile(
      "node",
      [OPENCLAW_MJS, "agent", "--agent", "main", "--session-key", key, "--message", voicePrefix + text, "--json"],
      { maxBuffer: 10 * 1024 * 1024, windowsHide: true, signal },
      // No timeout anywhere on purpose: long meta-queries (e.g. "go
      // read the codebase") can legitimately take several minutes.
      // The only kill switch is the AbortSignal — it fires when the
      // user sends a new @bot, disconnects, or hits Ctrl+C.
      (err, stdout) => {
        const elapsed = Date.now() - started;
        if (err) {
          reject(err);
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const reply =
            data?.result?.payloads?.[0]?.text ??
            data?.payloads?.[0]?.text ??
            data?.meta?.finalAssistantVisibleText ??
            data?.text ??
            "";
          console.log(`[OpenClaw] ${elapsed}ms, ${reply.length} chars`);
          resolve(stripMarkdown(reply));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "[代码]")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\n{2,}/g, "。")
    .replace(/\n/g, "。")
    .trim();
}

async function main() {
  requireEnv(["DISCORD_BOT_TOKEN", "GROQ_API_KEY", "MINIMAX_API_KEY"]);

  if (!existsSync(OPENCLAW_MJS)) {
    console.error(`[FATAL] openclaw.mjs not found at: ${OPENCLAW_MJS}`);
    console.error("Set OPENCLAW_MJS env var or install openclaw globally.");
    process.exit(1);
  }

  const agent: Agent = {
    async chat(text, participantId, signal) {
      const short = participantId.split(":").pop()?.slice(-6) ?? participantId.slice(-6);
      console.log(`[OpenClaw] ${short} asking...`);
      const reply = await openclawChat(text, participantId, signal);
      console.log(`[OpenClaw] ${short} reply: "${reply.slice(0, 60)}${reply.length > 60 ? "..." : ""}"`);
      return reply;
    },
  };

  const veynor = new VeynorSkill(agent, {
    groqApiKey: process.env["GROQ_API_KEY"],
    minimaxApiKey: process.env["MINIMAX_API_KEY"],
    minimaxModel: process.env["MINIMAX_MODEL"],
    transportId: "discord",
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[SHUTDOWN] disconnecting...");
    rl.close();
    await veynor.disconnect();
    process.exit(0);
  };
  rl.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await veynor.connect({ token: TOKEN, guildId: GUILD, channelName: CHANNEL });
  await veynor.join();

  console.log("[READY] OpenClaw voice agent live in Discord.\n");
  console.log("Press Ctrl+C to stop.\n");

  await new Promise(() => {});
}

main().catch((e) => {
  console.error("[OpenClaw] FATAL:", e);
  process.exit(1);
});
