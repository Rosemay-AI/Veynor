/**
 * veynor config — read/write .env values from the command line.
 *
 *   veynor config                    # show all
 *   veynor config list               # same as above
 *   veynor config get <KEY>          # print one value
 *   veynor config set <KEY> <VALUE>  # write to .env
 *   veynor config unset <KEY>        # remove from .env
 *
 * Modifications go to .env in the current working directory.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { CYAN, DIM, GREEN, RED, GRAY } from "../lib/ui.js";
import { loadEnv, ENV_FILE } from "../lib/env.js";

function readEnvFile() {
  if (!existsSync(ENV_FILE)) return "";
  return readFileSync(ENV_FILE, "utf-8");
}

function parseRawEnv(content) {
  // Preserves order, comments, and lines that loadEnv() loses.
  const lines = content.split("\n");
  return lines;
}

function setKey(lines, key, value) {
  const target = `${key}=${value}`;
  const idx = lines.findIndex((l) => l.match(new RegExp(`^\\s*${key}\\s*=`)));
  if (idx >= 0) {
    lines[idx] = target;
  } else {
    lines.push(target);
  }
  return lines;
}

function unsetKey(lines, key) {
  return lines.filter((l) => !l.match(new RegExp(`^\\s*${key}\\s*=`)));
}

function writeEnvFile(content) {
  writeFileSync(ENV_FILE, content, "utf-8");
}

export function cmdConfig(args, flags = {}) {
  const sub = args[0];
  const env = loadEnv();

  if (flags.help || sub === "help" || sub === "-h" || sub === "--help") {
    showConfigHelp();
    return;
  }

  // Default: list
  if (!sub || sub === "list") {
    console.log("");
    console.log(CYAN("  Config (from .env)"));
    console.log("");
    const keys = Object.keys(env).sort();
    if (keys.length === 0) {
      console.log(RED("  ✗ No .env found. Run: veynor init"));
      return;
    }
    for (const k of keys) {
      const v = env[k];
      const masked = k.includes("KEY") || k.includes("TOKEN") || k.includes("SECRET")
        ? v.slice(0, 4) + "***" + v.slice(-2)
        : v;
      console.log(`    ${k.padEnd(28)} ${GRAY(masked)}`);
    }
    console.log("");
    console.log(DIM(`  ${keys.length} keys in ${ENV_FILE}`));
    return;
  }

  if (sub === "get") {
    const key = args[1];
    if (!key) {
      console.error(RED("  ✗ Usage: veynor config get <KEY>"));
      process.exit(1);
    }
    if (env[key] === undefined) {
      console.error(RED(`  ✗ Key not set: ${key}`));
      process.exit(1);
    }
    console.log(env[key]);
    return;
  }

  if (sub === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) {
      console.error(RED("  ✗ Usage: veynor config set <KEY> <VALUE>"));
      process.exit(1);
    }
    const content = readEnvFile();
    const lines = parseRawEnv(content);
    setKey(lines, key, value);
    writeEnvFile(lines.join("\n") + "\n");
    console.log(GREEN(`  ✓ Set ${key}=${value.slice(0, 12)}${value.length > 12 ? "..." : ""}`));
    return;
  }

  if (sub === "unset") {
    const key = args[1];
    if (!key) {
      console.error(RED("  ✗ Usage: veynor config unset <KEY>"));
      process.exit(1);
    }
    const content = readEnvFile();
    const lines = parseRawEnv(content);
    const newLines = unsetKey(lines, key);
    writeEnvFile(newLines.join("\n") + "\n");
    console.log(GREEN(`  ✓ Removed ${key}`));
    return;
  }

  console.error(RED(`  ✗ Unknown sub-command: ${sub}`));
  console.error(DIM("    Usage: veynor config [list|get|set|unset]"));
  process.exit(1);
}

function showConfigHelp() {
  console.log("Veynor config / 配置管理");
  console.log("");
  console.log("Commands / 命令:");
  console.log("  veynor config list");
  console.log("  veynor config get <KEY>");
  console.log("  veynor config set <KEY> <VALUE>");
  console.log("  veynor config unset <KEY>");
  console.log("");
  console.log("Examples / 示例:");
  console.log("  veynor config set DISCORD_BOT_TOKEN <token>");
  console.log("  veynor config set GROQ_API_KEY <gsk_...>");
  console.log("  veynor config set MINIMAX_API_KEY <sk_...>");
  console.log("  veynor config get MINIMAX_MODEL");
  console.log("");
  console.log("Notes / 说明:");
  console.log("  Secrets are stored in .env and masked in `config list`.");
  console.log("  密钥保存在 .env 中，`config list` 会自动脱敏显示。");
}
