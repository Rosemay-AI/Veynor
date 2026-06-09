/**
 * veynor help - show the full command tree.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { BOLD, CYAN, DIM, YELLOW, banner } from "../lib/ui.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const COMMANDS = [
  {
    section: "Getting Started / 开始使用",
    items: [
      { cmd: "init", desc: "Initialize .env or scaffold a project / 初始化配置或创建项目" },
      { cmd: "doctor", desc: "Check Discord, STT, TTS, and backend / 检查运行环境" },
      { cmd: "config", desc: "Read and write .env values / 查看和修改配置" },
      { cmd: "agent", desc: "Register local agents / 管理本地 agent" },
      { cmd: "voice", desc: "Manage official, custom, and cloned voices / 管理音色" },
      { cmd: "meeting", desc: "Select roundtable agents / 选择会议 agent" },
      { cmd: "start", desc: "Start Veynor or a demo / 启动运行时或 demo" },
    ],
  },
  {
    section: "Help / 帮助",
    items: [
      { cmd: "help", desc: "Show this help / 显示帮助" },
      { cmd: "version", desc: "Show Veynor version / 显示版本" },
    ],
  },
];

export function showHelp() {
  banner();
  console.log(BOLD("  Veynor CLI") + DIM(" - Voice Neural Orchestrator"));
  console.log("");
  console.log(DIM("  open-source voice runtime and orchestration layer for AI agents"));
  console.log(DIM("  面向 AI Agent 的实时语音运行时：Discord 语音、STT、LLM、TTS、多人圆桌"));
  console.log("");

  for (const section of COMMANDS) {
    console.log(BOLD(`  ${section.section}`));
    console.log("");
    for (const { cmd, desc } of section.items) {
      console.log(`    ${YELLOW(cmd.padEnd(14))} ${DIM(desc)}`);
    }
    console.log("");
  }

  console.log(BOLD("  Quick start / 快速开始"));
  console.log("");
  console.log(`    ${CYAN("veynor init")}             ${DIM("# first run / 首次配置")}`);
  console.log(`    ${CYAN("veynor doctor")}           ${DIM("# verify setup / 检查配置")}`);
  console.log(`    ${CYAN("veynor voice help")}       ${DIM("# manage voices / 管理音色")}`);
  console.log(`    ${CYAN("veynor agent help")}       ${DIM("# manage agents / 管理 agent")}`);
  console.log(`    ${CYAN("veynor start echo")}       ${DIM("# cheap audio check / 低成本音频自检")}`);
  console.log(`    ${CYAN("veynor")}                  ${DIM("# go live / 启动默认运行时")}`);
  console.log("");
  console.log(DIM("  Docs:    https://github.com/Rosemay-AI/Veynor"));
  console.log(DIM("  License: MIT"));
  console.log("");
}

export function showVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    console.log(`veynor ${pkg.version}`);
  } catch {
    console.log("veynor (unknown version)");
  }
}
