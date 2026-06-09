/**
 * Agent start — launches agent(s) as independent child processes.
 *
 * Each agent runs with its own Discord bot identity (per-agent token) and
 * shares the root .env provider keys (Groq, MiniMax, LLM endpoint).
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { CYAN, DIM, GREEN, RED, YELLOW } from "../lib/ui.js";
import { readAgentRegistry } from "./agent.js";

export function cmdAgentStart(args, flags) {
  if (flags["all"]) {
    startAllAgents(flags);
    return;
  }

  const id = args[0] ?? flags.id;
  if (!id) {
    console.log(`${RED("Missing agent id.")} Use ${CYAN("veynor agent start <id>")} or ${CYAN("veynor agent start --all")}`);
    process.exit(1);
  }

  const registry = readAgentRegistry(flags);
  const agent = registry.agents.find((item) => item.id === id);
  if (!agent) {
    console.log(`${RED("Agent not found:")} ${id}`);
    console.log(DIM("Registered agents:"));
    for (const a of registry.agents) {
      console.log(`  ${a.id}${a.directory ? ` → ${a.directory}` : ""}`);
    }
    process.exit(1);
  }

  if (!agent.directory) {
    console.log(`${RED("Agent has no directory:")} ${id}`);
    console.log(DIM("The agent needs a --directory for per-agent Discord config. Use:"));
    console.log(DIM(`  veynor agent add ${id} --directory agents/${id} --discord-token <token> --guild <guild-id> --channel <channel>`));
    process.exit(1);
  }

  startSingleAgent(agent.id, flags);
}

function startAllAgents(flags) {
  const registry = readAgentRegistry(flags);
  const withDirectory = registry.agents.filter((agent) => agent.directory);

  if (withDirectory.length === 0) {
    console.log(RED("No agents have a directory configured."));
    console.log(DIM("Add agents with --directory to enable independent Discord connections."));
    process.exit(1);
  }

  console.log(GREEN(`Starting ${withDirectory.length} agent(s)...\n`));

  const STAGGER_MS = 3000; // 3s delay between each agent to avoid Discord rate limits
  const children = [];
  let started = 0;

  function startNext() {
    const agent = withDirectory[started];
    console.log(`${GREEN(`[${started + 1}/${withDirectory.length}]`)} Starting ${CYAN(agent.id)}...`);
    const child = spawnAgent(agent.id, flags);
    children.push(child);
    started++;

    if (started < withDirectory.length) {
      setTimeout(startNext, STAGGER_MS);
    } else {
      setTimeout(() => {
        console.log(DIM("\nAll agents started. Ctrl+C to stop."));
        setupShutdownHandler(children);
      }, 1000);
    }
  }

  startNext();
}

function startSingleAgent(id, flags) {
  console.log(GREEN(`Starting agent ${CYAN(id)}...`));
  const child = spawnAgent(id, flags);
  console.log(DIM("Ctrl+C to stop."));
  setupShutdownHandler([child]);
}

function spawnAgent(agentId, flags) {
  const entryScript = resolve(import.meta.dirname, "..", "agent-entry.js");
  const args = [entryScript, "--agent-id", agentId];
  if (flags.registry) args.push("--registry", String(flags.registry));
  if (flags["root-env"] || flags.rootEnv) args.push("--root-env", String(flags["root-env"] ?? flags.rootEnv));

  const child = spawn("node", args, {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: false,
  });

  child.on("error", (err) => {
    console.error(`${RED(`[${agentId}]`)} Failed to spawn:`, err.message);
  });

  child.on("exit", (code, signal) => {
    const reason = signal ? `signal ${signal}` : `exit ${code}`;
    if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
      console.log(`${DIM(`[${agentId}]`)} Stopped (${reason})`);
    } else {
      console.log(`${RED(`[${agentId}]`)} Crashed (${reason})`);
    }
  });

  return child;
}

function setupShutdownHandler(children) {
  let shuttingDown = false;

  const cleanup = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(DIM(`\nShutting down ${children.length} agent(s)...`));

    for (const child of children) {
      if (!child.killed && child.pid) {
        try {
          process.kill(child.pid, signal);
        } catch {}
      }
    }

    setTimeout(() => {
      for (const child of children) {
        if (!child.killed && child.pid) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }
      process.exit(0);
    }, 5000);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
}
