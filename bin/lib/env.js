/**
 * .env parsing, writing, and backup helpers.
 *
 * Centralizes all the logic that used to be duplicated across the
 * wizard, config command, and doctor.
 */

import { existsSync, readFileSync, copyFileSync, writeFileSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..", "..");
export const ENV_FILE = resolve(process.cwd(), ".env");

// ── Parse ──────────────────────────────────────────────────────

export function parseEnv(content) {
  const result = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    result[key] = val;
  }
  return result;
}

export function loadEnv(path = ENV_FILE) {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf-8"));
}

export const AGENT_REQUIRED_KEYS = ["DISCORD_BOT_TOKEN", "GUILD_ID", "VOICE_CHANNEL_NAME"];

export function agentEnvIsComplete(env) {
  return AGENT_REQUIRED_KEYS.every((k) => env[k] && env[k].length > 0);
}

/**
 * Merge root .env (shared provider keys) with an agent's own .env.
 * Agent values override root values. Returns the merged flat object.
 */
export function loadMergedEnv(agentDir, rootEnvPath = ENV_FILE) {
  const root = loadEnv(rootEnvPath);
  const agent = loadEnv(resolve(agentDir, ".env"));
  return { ...root, ...agent };
}

// ── Render ─────────────────────────────────────────────────────

/**
 * Render root .env — shared provider keys only.
 * Discord credentials are per-agent in agents/<id>/.env
 */
export function renderEnv(cfg) {
  const lines = [
    "# Veynor — shared provider API keys.",
    "# Discord tokens are per-agent: see agents/<id>/.env",
    "",
    "# ── LLM backend ──────────────────────────────────────────",
    `LLM_URL=${cfg["LLM_URL"] || ""}`,
    `LLM_API_KEY=${cfg["LLM_API_KEY"] || ""}`,
    `LLM_MODEL=${cfg["LLM_MODEL"] || ""}`,
    `OPENCLAW_URL=${cfg["OPENCLAW_URL"] || ""}`,
    "",
  ];

  if (cfg["GROQ_API_KEY"]) {
    lines.push(
      "# ── STT (Groq Whisper) ──────────────────────────────────",
      `GROQ_API_KEY=${cfg["GROQ_API_KEY"]}`,
      `GROQ_STT_MODEL=${cfg["GROQ_STT_MODEL"] || "whisper-large-v3"}`,
      `GROQ_STT_LANGUAGE=${cfg["GROQ_STT_LANGUAGE"] || "zh"}`,
      ""
    );
  }

  if (cfg["MINIMAX_API_KEY"]) {
    lines.push(
      "# ── TTS (MiniMax) ───────────────────────────────────────",
      `MINIMAX_API_KEY=${cfg["MINIMAX_API_KEY"]}`,
      `MINIMAX_MODEL=${cfg["MINIMAX_MODEL"] || "speech-2.8-hd"}`,
      `MINIMAX_LLM_MODEL=${cfg["MINIMAX_LLM_MODEL"] || "MiniMax-M3"}`,
      ""
    );
  }

  return lines.join("\n");
}

/**
 * Render an agent's .env — Discord credentials specific to one agent.
 */
export function renderAgentEnv(cfg) {
  const lines = [
    "# Veynor agent — Discord credentials.",
    "# This bot joins the same voice channel as other agents.",
    "",
    `DISCORD_BOT_TOKEN=${cfg["DISCORD_BOT_TOKEN"] || ""}`,
    `GUILD_ID=${cfg["GUILD_ID"] || ""}`,
    `VOICE_CHANNEL_NAME=${cfg["VOICE_CHANNEL_NAME"] || "General"}`,
    "",
  ];
  return lines.join("\n");
}

// ── Write (with backup) ───────────────────────────────────────

export function writeEnvWithBackup(path, content) {
  if (existsSync(path)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${path}.bak.${ts}`;
    try {
      copyFileSync(path, backup);
    } catch {}
  }
  writeFileSync(path, content, "utf-8");
}

export function appendToEnv(path, lines) {
  if (!existsSync(path)) {
    writeFileSync(path, lines.join("\n") + "\n", "utf-8");
    return;
  }
  const content = readFileSync(path, "utf-8");
  for (const line of lines) {
    const key = line.split("=")[0];
    if (content.includes(`${key}=`)) continue;
    appendFileSync(path, line + "\n", "utf-8");
  }
}
