/**
 * veynor init — interactively configure Veynor and (optionally)
 * generate a fresh project skeleton in a new directory.
 *
 * Two modes:
 *   1. veynor init          → wizard, writes .env in cwd
 *   2. veynor init <dir>    → also creates <dir>/{veynor.config.ts, .env, src/, package.json}
 *
 * Non-interactive:
 *   veynor init --yes --token=... --guild=... [--channel=...] [...]
 *   writes .env from flags, no prompt.
 */

import { existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import {
  BOLD, CYAN, DIM, GREEN, YELLOW, RED, GRAY,
  banner, makeRl, closeRl, ask, confirm, choose,
  isSnowflake, isLikelyToken,
} from "../lib/ui.js";
import {
  loadEnv, renderEnv, writeEnvWithBackup, ENV_FILE, ROOT,
} from "../lib/env.js";

/**
 * Project skeleton template. Used when `init` is called with a
 * directory argument. The user gets a complete, runnable starter.
 */
function renderProjectSkeleton(cfg) {
  return {
    "veynor.config.ts": `// Veynor project configuration.
//
// Shared provider keys (Groq, MiniMax, LLM) live in .env.
// Per-agent Discord tokens live in agents/<id>/.env.
// Use \`veynor agent add <id> --directory agents/<id>\` to register agents.

import { defineConfig } from "@veynor/cli";

export default defineConfig({
  // Agent backends. Each agent is a separate VeynorSkill process
  // with its own Discord bot identity.
  agent: {
    type: "openclaw-cli", // local openclaw.mjs subprocess
    openclawPath: process.env.OPENCLAW_MJS ?? "",
    voicePrefix:
      "你是语音助手，回复会被朗读。用标点控制语气：逗号停顿，省略号犹豫，感叹号加重，波浪号～轻快，句号平稳收尾。直接回复，不要思考过程。用户说：",
  },

  // Speech-to-text (optional, skips STT if omitted).
  stt: {
    type: "groq",
    apiKey: process.env.GROQ_API_KEY ?? "",
    model: "whisper-large-v3",
    language: "zh",
  },

  // Text-to-speech (optional, skips TTS if omitted).
  tts: {
    type: "minimax",
    apiKey: process.env.MINIMAX_API_KEY ?? "",
    model: "speech-2.8-hd",
  },
});
`,
    ".env": renderEnv(cfg),
    ".gitignore": `node_modules/
dist/
.env
.env.bak.*
*.log
.DS_Store
`,
    "package.json": JSON.stringify(
      {
        name: cfg.PROJECT_NAME || "veynor-agent",
        private: true,
        type: "module",
        scripts: {
          start: "veynor start",
          doctor: "veynor doctor",
        },
        dependencies: {
          "@veynor/cli": "latest",
        },
      },
      null,
      2
    ),
    "src/main.ts": `// Veynor project entry point.
//
// You can either:
//   1. Use the high-level factory (recommended):
//
//      import { veynor } from "@veynor/cli";
//      await veynor().run();
//
//   2. Or wire VeynorSkill + DiscordVoiceTransport by hand for
//      full control (see examples/hermes-demo).
//
// The factory auto-reads veynor.config.ts in this directory and
// .env. Run with: \`veynor start\`.

import { veynor } from "@veynor/cli";
import config from "../veynor.config.js";

await veynor(config).run();
`,
    "README.md": `# ${cfg.PROJECT_NAME || "Veynor Agent"}

A voice-native AI agent built with [Veynor](https://github.com/Rosemay-AI/Veynor).

## Run

\`\`\`bash
pnpm install
veynor doctor    # verify setup
veynor start     # go live
\`\`\`

## Configure

Edit \`veynor.config.ts\` for non-secret settings.
Edit \`.env\` for Discord token, API keys, etc.
`,
  };
}

// ── Interactive wizard ────────────────────────────────────────

async function runWizard(nonInteractive, flags) {
  banner();
  console.log(BOLD("  First-time setup"));
  console.log(DIM("  Shared provider keys. Discord tokens are per-agent."));
  console.log(DIM("  Use `veynor agent add <id> --directory agents/<id>` for per-agent setup."));
  console.log("");
  console.log(DIM("  Press Enter to accept defaults shown in [gray]."));
  console.log("");

  const existing = loadEnv();
  const cfg = { ...existing };

  // Apply flags first (non-interactive)
  const flagMap = {
    token: "DISCORD_BOT_TOKEN",
    guild: "GUILD_ID",
    channel: "VOICE_CHANNEL_NAME",
    "openclaw-mjs": "OPENCLAW_MJS",
    "openclaw-url": "OPENCLAW_URL",
    "llm-url": "LLM_URL",
    "llm-key": "LLM_API_KEY",
    "llm-model": "LLM_MODEL",
    "groq-key": "GROQ_API_KEY",
    "minimax-key": "MINIMAX_API_KEY",
    "minimax-model": "MINIMAX_MODEL",
    "minimax-llm-model": "MINIMAX_LLM_MODEL",
  };
  for (const [flag, envKey] of Object.entries(flagMap)) {
    if (typeof flags[flag] === "string") cfg[envKey] = flags[flag];
  }

  if (nonInteractive) {
    // No required keys at root level — provider keys are optional
  } else {
    const rl = makeRl();
    try {
      console.log(BOLD(CYAN("\n  ── LLM Backend ──\n")));
      const backend = await choose(rl, "Backend", [
        "OpenClaw  (any OpenAI-compatible HTTP endpoint)",
        "Mock  (canned responses — for testing the pipeline)",
        "Skip  (no LLM — STT transcripts will be logged but not answered)",
      ]);
      if (backend === 0) {
        cfg["LLM_URL"] = await ask(rl, "LLM endpoint URL", {
          default: existing["LLM_URL"] || "http://127.0.0.1:7860/v1/agent/chat",
          required: true,
        });
        const needKey = await confirm(rl, "Does this endpoint require an API key?", false);
        cfg["LLM_API_KEY"] = needKey
          ? await ask(rl, "API key (Bearer token)", { required: true })
          : "";
        cfg["LLM_MODEL"] = await ask(rl, "Model name (optional)", {
          default: existing["LLM_MODEL"] || "",
        });
        try {
          const u = new URL(cfg["LLM_URL"]);
          cfg["OPENCLAW_URL"] = `${u.protocol}//${u.host}`;
        } catch {
          cfg["OPENCLAW_URL"] = "http://127.0.0.1:7860";
        }
      } else if (backend === 1) {
        cfg["LLM_URL"] = "mock";
        cfg["OPENCLAW_URL"] = "";
      } else {
        cfg["LLM_URL"] = "";
        cfg["OPENCLAW_URL"] = "";
      }

      console.log(BOLD(CYAN("\n  ── STT (Speech-to-Text) ──\n")));
      if (await confirm(rl, "Configure Groq STT?", true)) {
        cfg["GROQ_API_KEY"] = await ask(rl, "Groq API key", { required: true });
        cfg["GROQ_STT_MODEL"] = await ask(rl, "STT model", { default: "whisper-large-v3" });
        cfg["GROQ_STT_LANGUAGE"] = await ask(rl, "STT language", { default: "zh" });
      }

      console.log(BOLD(CYAN("\n  ── TTS (Text-to-Speech) ──\n")));
      if (await confirm(rl, "Configure MiniMax for LLM + TTS?", true)) {
        cfg["MINIMAX_API_KEY"] = await ask(rl, "MiniMax API key", { required: true });
        cfg["MINIMAX_MODEL"] = await ask(rl, "TTS model", { default: "speech-2.8-hd" });
        cfg["MINIMAX_LLM_MODEL"] = await ask(rl, "LLM model", { default: "MiniMax-M3" });
      }
    } finally {
      closeRl(rl);
    }
  }

  // Write .env
  writeEnvWithBackup(ENV_FILE, renderEnv(cfg));
  console.log("");
  console.log(GREEN("  ✓ Configuration saved to .env"));
  console.log("");
}

async function run(targetDir, flags) {
  const nonInteractive = flags["yes"] === true || flags["non-interactive"] === true;

  if (targetDir) {
    // Create a fresh project skeleton
    const target = resolve(process.cwd(), targetDir);
    if (existsSync(target) && !flags["force"]) {
      console.error(RED(`  ✗ Target directory already exists: ${targetDir}`));
      console.error(DIM("    Use --force to overwrite, or pick a different name."));
      process.exit(1);
    }
    const projectName = targetDir.replace(/[\\/]/g, "-");
    const cfg = { PROJECT_NAME: projectName };
    // Pre-fill env with empty values so .env is valid out of the box
    cfg["DISCORD_BOT_TOKEN"] = "";
    cfg["GUILD_ID"] = "";
    cfg["VOICE_CHANNEL_NAME"] = "General";
    cfg["LLM_URL"] = "";
    cfg["LLM_API_KEY"] = "";
    cfg["LLM_MODEL"] = "";
    cfg["OPENCLAW_URL"] = "";

    const files = renderProjectSkeleton(cfg);
    if (nonInteractive) {
      // Auto-create, no wizard
      mkdirSync(target, { recursive: true });
      mkdirSync(join(target, "src"), { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(target, name), content, "utf-8");
      }
      console.log(GREEN(`  ✓ Project created: ${target}`));
      console.log(DIM(`    cd ${targetDir} && pnpm install && veynor init`));
      return;
    }

    // Interactive: ask for project name, then wizard
    banner();
    console.log(BOLD("  Create a new Veynor project"));
    console.log("");
    const rl = makeRl();
    try {
      const name = await ask(rl, "Project name", { default: projectName, required: true });
      cfg.PROJECT_NAME = name;
    } finally {
      closeRl(rl);
    }
    const newTarget = resolve(process.cwd(), cfg.PROJECT_NAME);
    if (existsSync(newTarget) && !flags["force"]) {
      console.error(RED(`  ✗ Directory already exists: ${cfg.PROJECT_NAME}`));
      process.exit(1);
    }
    mkdirSync(newTarget, { recursive: true });
    mkdirSync(join(newTarget, "src"), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(newTarget, name), content, "utf-8");
    }
    console.log("");
    console.log(GREEN(`  ✓ Project created: ${newTarget}`));
    console.log("");
    console.log(DIM("  Next:"));
    console.log(DIM(`    cd ${cfg.PROJECT_NAME}`));
    console.log(DIM("    pnpm install"));
    console.log(DIM("    veynor init          # fill in .env values"));
    console.log(DIM("    veynor doctor"));
    console.log(DIM("    veynor start"));
  } else {
    // Wizard mode — write .env in cwd
    await runWizard(nonInteractive, flags);
  }
}

export async function cmdInit(args, flags) {
  if (flags.help || args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    showInitHelp();
    return;
  }
  await run(args[0], flags);
}

function showInitHelp() {
  console.log("Veynor init / 初始化");
  console.log("");
  console.log("Commands / 命令:");
  console.log("  veynor init");
  console.log("  veynor init <dir>");
  console.log("");
  console.log("Flags / 参数:");
  console.log("  --yes, --non-interactive     不进入交互模式，使用传入参数");
  console.log("  --force                      创建项目目录时允许覆盖");
  console.log("  --llm-url <url>              自定义 OpenAI-compatible LLM endpoint");
  console.log("  --llm-key <key>              LLM_API_KEY");
  console.log("  --llm-model <model>          LLM_MODEL");
  console.log("  --groq-key <key>             GROQ_API_KEY，用于 STT");
  console.log("  --minimax-key <key>          MINIMAX_API_KEY，用于 LLM + TTS");
  console.log("  --minimax-model <model>      MINIMAX_MODEL，默认 speech-2.8-hd");
  console.log("  --minimax-llm-model <model>  MINIMAX_LLM_MODEL，默认 MiniMax-M3");
  console.log("  --openclaw-mjs <path>        OPENCLAW_MJS");
  console.log("  --openclaw-url <url>         OPENCLAW_URL");
  console.log("");
  console.log("Discord tokens are per-agent. After init, register agents:");
  console.log("  veynor agent add <id> --directory agents/<id> --discord-token <token> --guild <id> --channel <name>");
  console.log("");
  console.log("Examples / 示例:");
  console.log("  veynor init");
  console.log("  veynor init my-agent");
  console.log("  veynor init --yes --groq-key gsk_... --minimax-key sk_...");
}
