/**
 * veynor start — start the voice runtime.
 *
 * Three modes, picked by what's in the current directory:
 *
 *   1. Project with veynor.config.ts + src/main.ts
 *        → run `node src/main.ts` directly
 *
 *   2. Monorepo clone (this dir) — has examples/
 *        → use the existing demo picker (veynor start echo, etc.)
 *        → default to "openclaw" demo if no flag
 *
 *   3. Nothing useful found
 *        → error: "run veynor init first"
 */

import { existsSync } from "fs";
import { spawn } from "child_process";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { CYAN, DIM, RED, GREEN } from "../lib/ui.js";
import { loadEnv, agentEnvIsComplete } from "../lib/env.js";
import { selectMeetingAgents } from "./meeting.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const DEMOS = {
  echo: "examples/echo",
  hermes: "examples/hermes-demo",
  openclaw: "examples/openclaw-demo",
  agent: "examples/agent-demo",
};

function runDemo(demoKey) {
  const cwd = join(ROOT, DEMOS[demoKey]);
  if (!existsSync(cwd)) {
    console.error(RED(`  ✗ Demo not found: ${demoKey}`));
    process.exit(1);
  }
  console.log(CYAN(`  → Starting ${demoKey} demo in ${DEMOS[demoKey]}/`));
  console.log("");
  const child = spawn("pnpm", ["start"], { cwd, stdio: "inherit", shell: true });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function pickDefaultDemo(env) {
  // If user has a real LLM endpoint, prefer openclaw demo
  if (env["LLM_URL"] && env["LLM_URL"] !== "mock") return "openclaw";
  if (env["LLM_URL"] === "mock") return "echo";
  return "openclaw";
}

export function cmdStart(args, flags) {
  if (flags.help || args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    showStartHelp();
    return;
  }

  if (flags.agents) {
    const { meeting } = selectMeetingAgents([], flags);
    console.log(GREEN(`  Selected meeting agents: ${meeting.selectedAgentIds.join(", ")}`));
    console.log(DIM("  The voice runtime will use this selection for roundtable turns."));
    console.log("");
  }

  // Mode 1: project with veynor.config.ts
  if (existsSync(resolve(process.cwd(), "veynor.config.ts"))) {
    if (!existsSync(resolve(process.cwd(), "src", "main.ts"))) {
      console.error(RED("  ✗ Found veynor.config.ts but no src/main.ts"));
      console.error(DIM("    Run `veynor init` to scaffold a new project."));
      process.exit(1);
    }
    console.log(CYAN("  → Running project from ./src/main.ts"));
    const child = spawn("node", ["--import", "tsx", "src/main.ts"], {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: true,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  // Mode 2: monorepo with examples/
  if (existsSync(resolve(ROOT, "examples"))) {
    const demo = args[0];
    if (demo && demo in DEMOS) {
      return runDemo(demo);
    }
    // Default demo picker
    const env = loadEnv();
    // Legacy demo mode: only needs a Discord token in root .env for now
    if (!agentEnvIsComplete(env)) {
      console.error(RED("  ✗ Root .env missing Discord credentials for demo mode"));
      console.error(DIM("    For per-agent mode, use: veynor agent start <id>"));
      console.error(DIM("    For legacy demo, set DISCORD_BOT_TOKEN / GUILD_ID / VOICE_CHANNEL_NAME in .env"));
      process.exit(1);
    }
    const chosen = pickDefaultDemo(env);
    console.log(CYAN(`  → Auto-picked "${chosen}" demo based on your .env`));
    console.log(DIM(`    (use \`veynor start <demo>\` to pick another: ${Object.keys(DEMOS).join(", ")})`));
    console.log("");
    return runDemo(chosen);
  }

  // Mode 3: nothing useful
  console.error(RED("  ✗ No Veynor project found in this directory"));
  console.error(DIM("    Run `veynor init` to create one."));
  process.exit(1);
}

function showStartHelp() {
  console.log("Veynor start / 启动运行时");
  console.log("");
  console.log("Commands / 命令:");
  console.log("  veynor start");
  console.log("  veynor start echo");
  console.log("  veynor start hermes");
  console.log("  veynor start openclaw");
  console.log("  veynor start agent");
  console.log("  veynor agent start <id>       Start an agent with its own Discord bot");
  console.log("  veynor agent start --all      Start all registered agents");
  console.log("");
  console.log("Flags / 参数:");
  console.log("  --agents a,b,c  Select roundtable agents before starting / 启动前选择圆桌 agent");
  console.log("");
  console.log("Examples / 示例:");
  console.log("  veynor start echo                         # Discord audio loopback / 音频链路自检");
  console.log("  veynor start agent                        # Groq STT + MiniMax LLM/TTS");
  console.log("  veynor start --agents architect,critic    # Select roundtable agents then start");
  console.log("  veynor agent start architect              # Start single agent with own bot");
  console.log("  veynor agent start --all                  # Start all registered agents");
}
