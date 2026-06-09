#!/usr/bin/env node
/**
 * veynor — one-command entry point.
 *
 *   veynor              start the voice runtime (default)
 *   veynor help         show help
 *   veynor version      show version
 *   veynor init         configure .env (or scaffold a new project)
 *   veynor doctor       end-to-end env check
 *   veynor config       read/write .env values
 *   veynor agent        manage local agent registry
 *   veynor voice        manage TTS voice profiles
 *   veynor meeting      select agents for the current roundtable
 *   veynor start        start the voice runtime
 *
 * Cross-platform. Uses Node's built-in readline for the wizard.
 * No extra dependencies required.
 */

import { parseArgs } from "./lib/flags.js";
import { showHelp, showVersion } from "./commands/help.js";
import { cmdInit } from "./commands/init.js";
import { cmdConfig } from "./commands/config.js";
import { cmdAgent } from "./commands/agent.js";
import { cmdVoice } from "./commands/voice.js";
import { cmdMeeting } from "./commands/meeting.js";
import { cmdStart } from "./commands/start.js";
import { cmdDoctor, showDoctorHelp } from "./commands/doctor.js";

async function main() {
  const { cmd, flags, positional } = parseArgs(process.argv.slice(2));

  // Global flags
  if (flags.version) {
    showVersion();
    return;
  }

  // Dispatch
  switch (cmd) {
    case undefined:
    case null:
      if (flags.help) {
        showHelp();
        return;
      }
      cmdStart(positional, flags);
      return;

    case "help":
      showHelp();
      return;

    case "version":
    case "-v":
    case "--version":
      showVersion();
      return;

    case "init":
      await cmdInit(positional, flags);
      return;

    case "doctor":
      if (flags.help || positional[0] === "help" || positional[0] === "-h" || positional[0] === "--help") {
        showDoctorHelp();
        return;
      }
      await cmdDoctor();
      return;

    case "config":
      cmdConfig(positional, flags);
      return;

    case "agent":
      await cmdAgent(positional, flags);
      return;

    case "voice":
      cmdVoice(positional, flags);
      return;

    case "meeting":
      cmdMeeting(positional, flags);
      return;

    case "start":
      cmdStart(positional, flags);
      return;

    default:
      // Unknown command → show help
      console.error(`\n  ✗ Unknown command: ${cmd}\n`);
      showHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n  ✗ ${e?.message || e}\n`);
  if (e?.stack && process.env["VEYNOR_DEBUG"]) console.error(e.stack);
  process.exit(1);
});
