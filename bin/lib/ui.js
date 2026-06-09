/**
 * Shared UI utilities for the Veynor CLI.
 *
 * Cross-platform: works in PowerShell, cmd, bash, zsh, fish.
 * Colors auto-disable when stdout is not a TTY or NO_COLOR is set.
 */

import * as readline from "readline";

// ── ANSI colors ───────────────────────────────────────────────

const supportsColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const c = (color, s) => (supportsColor ? `\x1b[${color}m${s}\x1b[0m` : s);

export const BOLD = (s) => c("1", s);
export const DIM = (s) => c("2", s);
export const CYAN = (s) => c("36", s);
export const GREEN = (s) => c("32", s);
export const YELLOW = (s) => c("33", s);
export const RED = (s) => c("31", s);
export const GRAY = (s) => c("90", s);

// ── Banner ────────────────────────────────────────────────────

export function banner() {
  console.log("");
  console.log(CYAN("  ╔═══════════════════════════════════════════╗"));
  console.log(CYAN("  ║") + BOLD("       Veynor — Voice Neural Orchestrator  ") + CYAN("║"));
  console.log(CYAN("  ╚═══════════════════════════════════════════╝"));
  console.log("");
}

// ── readline helpers ──────────────────────────────────────────

export function makeRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

export function closeRl(rl) {
  try { rl.close(); } catch {}
}

export async function ask(rl, question, opts = {}) {
  const defaultSuffix = opts.default !== undefined ? ` ${GRAY(`[${opts.default}]`)}` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${defaultSuffix}\n  ${YELLOW("›")} `, (answer) => {
      const v = answer.trim();
      if (!v && opts.default !== undefined) return resolve(String(opts.default));
      if (!v && opts.required) {
        console.log(`  ${RED("✗")} This field is required.`);
        return resolve(ask(rl, question, opts));
      }
      if (opts.validate && !opts.validate(v)) {
        console.log(`  ${RED("✗")} ${opts.invalidMsg || "Invalid input"}`);
        return resolve(ask(rl, question, opts));
      }
      resolve(v);
    });
  });
}

export async function confirm(rl, question, defaultYes = true) {
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}\n  ${YELLOW("›")} `, (answer) => {
      const v = answer.trim().toLowerCase();
      if (!v) return resolve(defaultYes);
      resolve(v === "y" || v === "yes");
    });
  });
}

export async function choose(rl, question, options) {
  console.log(`  ${question}`);
  options.forEach((opt, i) => {
    const num = YELLOW(`  ${(i + 1).toString().padStart(2)}.`);
    console.log(`${num} ${opt}`);
  });
  return new Promise((resolve) => {
    rl.question(`  ${YELLOW("›")} `, (answer) => {
      const v = parseInt(answer.trim(), 10);
      if (isNaN(v) || v < 1 || v > options.length) {
        console.log(`  ${RED("✗")} Please enter 1-${options.length}`);
        return resolve(choose(rl, question, options));
      }
      resolve(v - 1);
    });
  });
}

// ── Validation helpers ────────────────────────────────────────

export const isSnowflake = (s) => /^\d{17,20}$/.test(s);
export const isNonEmpty = (s) => s.length > 0;
export const isLikelyToken = (s) => s.length >= 20;
