/**
 * Agent entry point — standalone process for a single agent.
 *
 * Invoked by `veynor agent start <id>` as a child process:
 *   node ./bin/agent-entry.js --agent-id <id>
 *
 * Each agent process:
 *   1. Loads merged env (root .env + agent .env)
 *   2. Creates the Agent adapter (http/stdio/module)
 *   3. Creates VeynorSkill with the agent
 *   4. Connects to Discord with its own bot token
 *   5. Runs until SIGINT/SIGTERM
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { loadMergedEnv, agentEnvIsComplete, ENV_FILE } from "./lib/env.js";
import { readAgentRegistry } from "./commands/agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse argv ──────────────────────────────────────────────────

function parseArgv() {
  const args = process.argv.slice(2);
  const result = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent-id" && i + 1 < args.length) {
      result.agentId = args[++i];
    } else if (args[i] === "--root-env" && i + 1 < args.length) {
      result.rootEnv = args[++i];
    } else if (args[i] === "--registry" && i + 1 < args.length) {
      result.registry = args[++i];
    } else if (args[i].startsWith("--agent-id=")) {
      result.agentId = args[i].slice("--agent-id=".length);
    } else if (args[i].startsWith("--root-env=")) {
      result.rootEnv = args[i].slice("--root-env=".length);
    } else if (args[i].startsWith("--registry=")) {
      result.registry = args[i].slice("--registry=".length);
    }
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const argv = parseArgv();
  const id = argv.agentId;
  if (!id) {
    console.error("[FATAL] --agent-id <id> is required");
    process.exit(1);
  }

  const cwd = process.cwd();
  const rootEnvPath = argv.rootEnv ? resolve(cwd, argv.rootEnv) : ENV_FILE;
  const prefix = `[${id}]`;

  // 1. Read agent definition from registry
  const registry = readAgentRegistry(argv.registry ? { registry: argv.registry } : {});
  const def = registry.agents.find((agent) => agent.id === id);
  if (!def) {
    console.error(`${prefix} Agent not found in registry`);
    process.exit(1);
  }

  // 2. Load merged env
  if (!def.directory) {
    console.error(`${prefix} Agent has no directory configured. Use 'veynor agent add ${id} --directory agents/${id} ...'`);
    process.exit(1);
  }

  const agentDir = resolve(cwd, def.directory);
  const merged = loadMergedEnv(agentDir, rootEnvPath);
  Object.assign(process.env, merged);

  if (!agentEnvIsComplete(merged)) {
    console.error(`${prefix} Agent env incomplete. Ensure ${agentDir}/.env has:`);
    console.error(`${prefix}   DISCORD_BOT_TOKEN=<token>`);
    console.error(`${prefix}   GUILD_ID=<guild-id>`);
    console.error(`${prefix}   VOICE_CHANNEL_NAME=<channel>`);
    process.exit(1);
  }

  const token = merged["DISCORD_BOT_TOKEN"];
  const guildId = merged["GUILD_ID"];
  const channelName = merged["VOICE_CHANNEL_NAME"];
  const groqApiKey = merged["GROQ_API_KEY"] || undefined;
  const minimaxApiKey = merged["MINIMAX_API_KEY"] || undefined;
  const minimaxModel = merged["MINIMAX_MODEL"] || undefined;

  console.log(`${prefix} Discord token: ${token.slice(0, 8)}...`);
  console.log(`${prefix} Guild: ${guildId}  Channel: ${channelName}`);
  console.log(`${prefix} STT: ${groqApiKey ? "Groq" : "N/A"}  TTS: ${minimaxApiKey ? "MiniMax" : "N/A"}`);

  // 3. Create Agent adapter via dynamic import of the agent package
  // Prefer the npm-resolved path; fall back to monorepo dist for development.
  let agentPkgPath = resolve(cwd, "packages", "agent", "dist", "index.js");
  try {
    const resolved = import.meta.resolve("@veynor/agent");
    if (resolved.startsWith("file://")) {
      const candidate = fileURLToPath(resolved);
      if (existsSync(candidate)) agentPkgPath = candidate;
    }
  } catch {}
  if (!existsSync(agentPkgPath)) {
    console.error(`${prefix} Agent package not found. Run: pnpm build`);
    process.exit(1);
  }

  const agentModule = await import(pathToFileURL(agentPkgPath).href);
  const createAgentAdapter = agentModule.createAgentAdapter;
  if (!createAgentAdapter) {
    console.error(`${prefix} createAgentAdapter not exported from @veynor/agent`);
    process.exit(1);
  }

  const agent = await createAgentAdapter(def, cwd);
  console.log(`${prefix} Agent adapter created (type: ${def.type})`);

  // 4. Create VeynorSkill
  const VeynorSkill = agentModule.VeynorSkill;
  if (!VeynorSkill) {
    console.error(`${prefix} VeynorSkill not exported from @veynor/agent`);
    process.exit(1);
  }

  const skill = new VeynorSkill(agent, {
    groqApiKey,
    minimaxApiKey,
    minimaxModel,
  });

  // 5. Connect and join
  await skill.connect({ token, guildId, channelName });
  console.log(`${prefix} Connected to Discord`);

  await skill.join();
  console.log(`${prefix} Joined voice channel`);

  // 6. Wait for shutdown
  const shutdown = async () => {
    console.log(`${prefix} Shutting down...`);
    await skill.leave().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
