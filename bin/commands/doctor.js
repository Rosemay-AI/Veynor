/**
 * veynor doctor — end-to-end environment + dependency check.
 *
 *   Discord      — login + locate guild + locate voice channel
 *   STT          — synthesize silence, check Whisper returns empty
 *   TTS          — synthesize "test", check audio bytes
 *   OpenClaw     — spawn CLI subprocess OR hit HTTP gateway
 *   OpenClaw.mjs — auto-discover the .mjs path
 *
 * Exits non-zero on any required failure.
 */

import { BOLD, DIM, CYAN, GREEN, RED, YELLOW, banner } from "../lib/ui.js";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const ENV_FILE = resolve(process.cwd(), ".env");

/** Graceful exit that avoids libuv handle-race crash on Windows. */
function safeExit(code) {
  setTimeout(() => process.exit(code), 100);
}

export async function cmdDoctor() {
  banner();
  console.log(BOLD("  End-to-end doctor"));
  console.log(DIM("  Testing every link in the chain independently.\n"));

  // Quick pre-check: is .env even present?
  const envExists = existsSync(ENV_FILE);
  if (!envExists) {
    console.log(RED("  ✗ .env not found"));
    console.log("");
    console.log(YELLOW("  → Run ") + GREEN("veynor init") + YELLOW(" first to create your .env"));
    console.log("");
    console.log(DIM("    Or set env vars directly: DISCORD_BOT_TOKEN, GUILD_ID, VOICE_CHANNEL_NAME,"));
    console.log(DIM("    GROQ_API_KEY, MINIMAX_API_KEY, OPENCLAW_MJS"));
    console.log("");
    safeExit(1);
  }

  // Dynamic import so the doctor isn't loaded unless the user asks.
  // We use a relative path into the workspace because bin/ lives
  // outside any package — it can't resolve bare specifiers like
  // "@veynor/agent" via Node's package resolution algorithm.
  // tsup bundles doctor into packages/agent/dist/index.js.
  const indexUrl = new URL("../../packages/agent/dist/index.js", import.meta.url);
  const { runDoctor: doctor } = await import(indexUrl.href);

  const onResult = (r) => {
    const mark = r.ok ? GREEN("✓") : RED("✗");
    const dur = DIM(`(${r.durationMs}ms)`);
    const tag = r.skipped ? DIM("[skipped]") : "";
    console.log(`  ${mark} ${BOLD(r.name).padEnd(20)} ${dur}  ${r.detail} ${tag}`);
  };

  const report = await doctor({ onResult });

  // Show "what failed and what to do"
  console.log("");
  if (report.failedRequired > 0) {
    const env = readEnv();
    const failed = report.results.filter((r) => !r.ok && !r.skipped);
    const missingKeys = [];
    if (failed.some((r) => r.name === "Discord" && r.detail.includes("not set"))) {
      missingKeys.push("DISCORD_BOT_TOKEN / GUILD_ID / VOICE_CHANNEL_NAME");
    }
    if (failed.some((r) => r.name === "Groq STT")) {
      missingKeys.push("GROQ_API_KEY");
    }
    if (failed.some((r) => r.name === "MiniMax TTS")) {
      missingKeys.push("MINIMAX_API_KEY");
    }
    if (failed.some((r) => r.name === "OpenClaw" && r.detail.includes("Neither"))) {
      missingKeys.push("OPENCLAW_MJS or OPENCLAW_URL");
    }

    console.log(RED(`  ✗ ${report.failedRequired} required test(s) failed in ${report.totalMs}ms`));
    if (missingKeys.length > 0) {
      console.log("");
      console.log(YELLOW("  Missing env vars — set these in .env:"));
      for (const k of missingKeys) {
        console.log(`    ${CYAN(k)}`);
      }
      console.log("");
      console.log(DIM("  Quick fix:"));
      console.log(DIM(`    veynor config set ${missingKeys[0].split(" / ")[0]} <value>`));
    } else {
      console.log(DIM("  Fix the items above and re-run `veynor doctor`."));
    }
    safeExit(1);
  } else {
    console.log(GREEN(`  ✓ All checks passed in ${report.totalMs}ms`));
    console.log(DIM("  You're ready. Run: veynor start"));
  }
}

export function showDoctorHelp() {
  console.log("Veynor doctor / 环境检查");
  console.log("");
  console.log("Command / 命令:");
  console.log("  veynor doctor");
  console.log("");
  console.log("Checks / 检查项:");
  console.log("  Root .env    shared provider keys: GROQ_API_KEY, MINIMAX_API_KEY, LLM_URL");
  console.log("  Agent .env   agents/<id>/.env: DISCORD_BOT_TOKEN, GUILD_ID, VOICE_CHANNEL_NAME");
  console.log("  Groq STT     GROQ_API_KEY, whisper-large-v3");
  console.log("  MiniMax TTS  MINIMAX_API_KEY, speech-2.8-hd");
  console.log("  OpenClaw     OPENCLAW_MJS or OPENCLAW_URL");
  console.log("");
  console.log("Examples / 示例:");
  console.log("  veynor doctor");
  console.log("  VEYNOR_DEBUG=1 veynor doctor");
}

function readEnv() {
  try {
    const content = readFileSync(ENV_FILE, "utf-8");
    const result = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return result;
  } catch {
    return {};
  }
}
