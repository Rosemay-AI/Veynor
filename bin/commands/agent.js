import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { pathToFileURL } from "url";
import { execFile } from "child_process";
import { CYAN, DIM, GREEN, RED, YELLOW, BOLD, GRAY, banner, makeRl, closeRl, choose, ask, confirm } from "../lib/ui.js";
import { ENV_FILE, loadEnv, loadMergedEnv, renderAgentEnv, agentEnvIsComplete } from "../lib/env.js";

const DEFAULT_REGISTRY_PATH = ".veynor/agents.json";
const SUPPORTED_TYPES = new Set(["http", "stdio", "module"]);

export async function cmdAgent(positional, flags) {
  if (flags.help) {
    showAgentHelp();
    return;
  }

  const action = positional[0] ?? "list";

  switch (action) {
    case "add":
      await addAgent(positional.slice(1), flags);
      return;
    case "setup":
      await setupAgent(positional.slice(1), flags);
      return;
    case "list":
    case "ls":
      listAgents(flags);
      return;
    case "show":
      showAgent(positional.slice(1), flags);
      return;
    case "remove":
    case "rm":
      removeAgent(positional.slice(1), flags);
      return;
    case "export":
      exportAgents(flags);
      return;
    case "start":
      await cmdAgentStart(positional.slice(1), flags);
      return;
    case "env":
      cmdAgentEnv(positional.slice(1), flags);
      return;
    case "help":
    case "-h":
    case "--help":
      showAgentHelp();
      return;
    default:
      console.error(`${RED("Unknown agent command:")} ${action}\n`);
      showAgentHelp();
      process.exit(1);
  }
}

async function addAgent(args, flags) {
  const id = args[0] ?? flags.id;
  if (!id) fail("Missing agent id. Example: veynor agent add architect --type http --url http://127.0.0.1:8788/chat");

  const type = String(flags.type ?? "http");
  if (!SUPPORTED_TYPES.has(type)) fail(`Unsupported agent type: ${type}. Use http, stdio, or module.`);

  // 提前检查：是否覆盖已有配置
  const registry = readRegistry(flags);
  const existingIndex = registry.agents.findIndex((agent) => agent.id === id);
  if (existingIndex >= 0) {
    const ok = await confirmOverwrite(registry.agents[existingIndex], flags);
    if (!ok) {
      console.log(DIM("Cancelled. Existing agent kept."));
      return;
    }
  }

  const agent = cleanObject({
    id,
    type,
    role: flags.role ?? id,
    directory: flags.directory,
    displayName: flags.name ?? flags.displayName,
    domains: parseList(flags.domains),
    voiceId: flags.voice ?? flags.voiceId,
    ttsModel: flags.ttsModel,
    ttsSpeed: parseNumber(flags.ttsSpeed),
    ttsVolume: parseNumber(flags.ttsVolume),
    ttsPitch: parseNumber(flags.ttsPitch),
    maxSpeakMs: parseInteger(flags.maxSpeakMs),
    timeoutMs: parseInteger(flags.timeoutMs),
    canChallenge: parseBoolean(flags.canChallenge),
    canSummarize: parseBoolean(flags.canSummarize),
    transport: cleanObject({
      url: flags.url,
      command: flags.cmd ?? flags.command,
      args: parseList(flags.args),
      shell: parseBoolean(flags.shell),
      module: flags.module,
      cwd: flags.cwd,
    }),
    metadata: cleanObject({
      addedAt: existingIndex >= 0 ? registry.agents[existingIndex].metadata?.addedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  });

  validateAgent(agent);

  // 实际匹配探测：先验证连接，再决定是否写注册表
  const shouldSave = await runMatch(agent, flags, flags._rl);
  if (!shouldSave) {
    console.log(DIM("Cancelled. Configuration not saved."));
    return;
  }

  if (agent.directory) {
    const agentDir = resolve(process.cwd(), agent.directory);
    mkdirSync(agentDir, { recursive: true });
    writeAgentEnvIfConfigured(agentDir, flags);
    console.log(`${GREEN("Created agent directory")} ${agentDir}`);
  }

  if (existingIndex >= 0) {
    registry.agents[existingIndex] = agent;
    writeRegistry(registry, flags);
    console.log(`${GREEN("Updated agent")} ${CYAN(id)} ${DIM(`in ${registry.path}`)}`);
    return;
  }

  registry.agents.push(agent);
  registry.agents.sort((a, b) => a.id.localeCompare(b.id));
  writeRegistry(registry, flags);
  console.log(`${GREEN("Added agent")} ${CYAN(id)} ${DIM(`to ${registry.path}`)}`);
}

function listAgents(flags) {
  const registry = readRegistry(flags);
  if (registry.agents.length === 0) {
    console.log(DIM(`No agents registered in ${registry.path}`));
    console.log(DIM("Add one with: veynor agent add architect --type http --url http://127.0.0.1:8788/chat"));
    return;
  }

  console.log(DIM(`Registry: ${registry.path}\n`));
  for (const agent of registry.agents) {
    const endpoint = agent.transport?.url ?? agent.transport?.command ?? agent.transport?.module ?? "(no endpoint)";
    const voice = agent.voiceId ? ` voice=${agent.voiceId}` : "";
    const dir = agent.directory ? ` dir=${agent.directory}` : "";
    console.log(`${CYAN(agent.id.padEnd(18))} ${YELLOW(agent.type.padEnd(6))} ${agent.role}${voice}${dir}`);
    console.log(`  ${DIM(endpoint)}`);
  }
}

function showAgent(args, flags) {
  const id = args[0] ?? flags.id;
  if (!id) fail("Missing agent id. Example: veynor agent show architect");
  const registry = readRegistry(flags);
  const agent = registry.agents.find((item) => item.id === id);
  if (!agent) fail(`Agent not found: ${id}`);
  console.log(JSON.stringify(agent, null, 2));
}

function removeAgent(args, flags) {
  const id = args[0] ?? flags.id;
  if (!id) fail("Missing agent id. Example: veynor agent remove architect");
  const registry = readRegistry(flags);
  const next = registry.agents.filter((agent) => agent.id !== id);
  if (next.length === registry.agents.length) fail(`Agent not found: ${id}`);
  registry.agents = next;
  writeRegistry(registry, flags);
  console.log(`${GREEN("Removed agent")} ${CYAN(id)} ${DIM(`from ${registry.path}`)}`);
}

function exportAgents(flags) {
  const registry = readRegistry(flags);
  console.log(JSON.stringify({ version: registry.version, agents: registry.agents }, null, 2));
}

function showAgentHelp() {
  console.log("Veynor agent registry / Agent 注册表");
  console.log("");
  console.log("Commands / 命令:");
  console.log("  veynor agent add <id> --type http --url <url> --role <role>");
  console.log("  veynor agent add <id> --type stdio --cmd \"node agent.js\" --role <role>");
  console.log("  veynor agent add <id> --type module --module ./examples/agents/architect-agent.js --role <role>");
  console.log("  veynor agent setup                               交互式配置 Agent");
  console.log("  veynor agent setup --discord-token <token> --guild <id>  快捷配置");
  console.log("  veynor agent setup claude-code --discord-token <t> --guild <id>");
  console.log("  veynor agent list");
  console.log("  veynor agent show <id>");
  console.log("  veynor agent remove <id>");
  console.log("  veynor agent export");
  console.log("  veynor agent start <id>            Start an agent with its own Discord bot");
  console.log("  veynor agent start --all           Start all registered agents");
  console.log("  veynor agent env <id>              Show merged env for an agent");
  console.log("");
  console.log("Common flags / 常用参数:");
  console.log("  --registry <path>       Agent 注册表路径，默认 .veynor/agents.json");
  console.log("  --type http|stdio|module Agent 调用方式");
  console.log("  --role <role>           Agent 角色，例如 architect、critic、planner");
  console.log("  --directory <path>      Agent 自包含目录，例如 agents/architect");
  console.log("  --discord-token <t>     Discord Bot Token，写入 agents/<id>/.env");
  console.log("  --guild <id>            Discord 服务器 ID");
  console.log("  --channel <name>        Discord 语音频道名");
  console.log("  --openclaw-mjs <path>   OpenClaw CLI 入口，例如 D:\\npm-global\\node_modules\\openclaw\\openclaw.mjs");
  console.log("  --openclaw-agent <name> OpenClaw agent 名称，默认 main");
  console.log("  --groq-key <key>        写入根 .env，用于 STT");
  console.log("  --minimax-key <key>     写入根 .env，用于 MiniMax LLM + TTS");
  console.log("  --start                 setup 完成后立即启动该 agent");
  console.log("  --force                 setup 时覆盖已存在的 adapter 文件");
  console.log("  --domains a,b,c         能力领域，用于会议选择");
  console.log("  --voice <voice-id>      TTS 音色 ID，也可用 `veynor voice use` 绑定");
  console.log("  --ttsModel <model>      TTS 模型，例如 speech-2.8-hd");
  console.log("  --ttsSpeed <n>          语速覆盖");
  console.log("  --ttsVolume <n>         音量覆盖");
  console.log("  --ttsPitch <n>          音高覆盖");
  console.log("  --timeoutMs <ms>        Agent 调用超时，运行时默认 120000");
  console.log("  --args a,b,c            stdio 参数，不经过 shell 解析");
  console.log("  --shell true            stdio 命令通过 shell 运行");
  console.log("  --canChallenge true     是否允许发起挑战");
  console.log("  --canSummarize true     是否允许总结");
  console.log("");
  console.log("Available presets / 可用预设:");
  for (const p of AVAILABLE_PRESETS) {
    const mode = p.needsOpenClawPath ? "CLI (node + .mjs)" : p.httpModes && !p.cliCommand ? "HTTP (serve)" : `CLI (${p.cliCommand} ${(p.cliArgs ?? []).join(" ")})`;
    console.log(`  ${CYAN(p.id.padEnd(14))} ${p.name.padEnd(12)} ${DIM(mode)}`);
  }
  console.log("");
  console.log("Examples / 示例:");
  console.log("  veynor agent add architect --type http --url http://127.0.0.1:8788/chat --role architect");
  console.log("  veynor agent add architect --directory agents/architect --discord-token MT... --guild 9379... --channel \"voice-lab\"");
  console.log("  veynor agent setup                                交互式选择预设");
  console.log("  veynor agent setup openclaw --discord-token MT... --guild 9379... --start");
  console.log("  veynor voice use architect assistant");
  console.log("  veynor meeting select architect critic");
  console.log("  veynor agent start architect");
  console.log("  veynor agent env architect");
}

export function readAgentRegistry(flags = {}) {
  return readRegistry(flags);
}

export function writeAgentRegistry(registry, flags = {}) {
  writeRegistry(registry, flags);
}

function readRegistry(flags) {
  const path = registryPath(flags);
  if (!existsSync(path)) {
    return { version: 2, path, agents: [] };
  }

  const data = JSON.parse(readFileSync(path, "utf-8"));
  return {
    version: data.version ?? 2,
    path,
    agents: Array.isArray(data.agents) ? data.agents : [],
  };
}

function writeRegistry(registry, flags) {
  const path = registryPath(flags);
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomically(path, { version: registry.version ?? 2, agents: registry.agents });
}

function writeJsonAtomically(path, data) {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, path);
}

function registryPath(flags) {
  return resolve(process.cwd(), flags.registry ?? DEFAULT_REGISTRY_PATH);
}

function validateAgent(agent) {
  if (agent.type === "http" && !agent.transport?.url) fail("HTTP agent requires --url");
  if (agent.type === "stdio" && !agent.transport?.command) fail("stdio agent requires --cmd");
  if (agent.type === "module" && !agent.transport?.module) fail("module agent requires --module");
}

function parseList(value) {
  if (!value) return undefined;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`Expected number, got ${value}`);
  return number;
}

function parseInteger(value) {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") fail(`Expected integer, got boolean: ${value}`);
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) fail(`Expected integer, got ${value}`);
  return number;
}

function parseBoolean(value) {
  if (value === undefined) return undefined;
  if (value === true || value === "true" || value === "1" || value === "yes") return true;
  if (value === false || value === "false" || value === "0" || value === "no") return false;
  fail(`Expected boolean, got ${value}`);
}

function cleanObject(value) {
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== "") next[key] = item;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function writeAgentEnvIfConfigured(agentDir, flags) {
  if (!flags["discord-token"] && !flags.guild && !flags.channel) return;

  const envPath = resolve(agentDir, ".env");
  const existing = existsSync(envPath) ? loadEnv(envPath) : {};
  const envContent = renderAgentEnv({
    DISCORD_BOT_TOKEN: flags["discord-token"] ?? existing["DISCORD_BOT_TOKEN"] ?? "",
    GUILD_ID: flags.guild ?? existing["GUILD_ID"] ?? "",
    VOICE_CHANNEL_NAME: flags.channel ?? existing["VOICE_CHANNEL_NAME"] ?? "General",
  });
  writeFileSync(envPath, envContent, "utf-8");
}

const AVAILABLE_PRESETS = [
  {
    id: "claude-code",
    name: "Claude Code",
    desc: "Anthropic，claude -p 管道调用，纯文本输出",
    displayName: "Claude",
    role: "claude",
    domains: ["general", "coding"],
    cliCommand: "claude",
    cliArgs: ["-p"],
    cliJson: false,
  },
  {
    id: "codex",
    name: "Codex CLI",
    desc: "OpenAI，codex exec 调用，支持 --serve HTTP 模式",
    displayName: "Codex",
    role: "codex",
    domains: ["general", "coding"],
    cliCommand: "codex",
    cliArgs: ["exec"],
    cliJson: false,
    httpModes: [{ label: "CLI 模式 (codex exec)", type: "module" }, { label: "HTTP 模式 (codex serve → /v1/chat/completions)", type: "http", url: "http://127.0.0.1:{port}/v1/chat/completions", portFlag: "port" }],
  },
  {
    id: "hermes",
    name: "Hermes",
    desc: "Agent 工具调用标准化胶水，需先运行 hermes serve",
    displayName: "Hermes",
    role: "hermes",
    domains: ["general", "tool-use"],
    httpModes: [{ label: "HTTP (hermes serve)", type: "http", url: "http://127.0.0.1:{port}/api/chat", portFlag: "port" }],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    desc: "个人 AI 助理操作系统，支持 Discord/Telegram 多平台",
    displayName: "OpenClaw",
    role: "openclaw",
    domains: ["general", "voice"],
    needsOpenClawPath: true,
  },
  {
    id: "trae-solo",
    name: "Trae Solo",
    desc: "trae -p 管道调用，支持 --serve 暴露 HTTP API",
    displayName: "Trae",
    role: "trae",
    domains: ["general", "coding"],
    cliCommand: "trae",
    cliArgs: ["-p"],
    cliJson: false,
  },
];

async function setupAgent(args, flags) {
  const presetId = String(args[0] ?? flags.preset ?? "").toLowerCase();
  let preset = presetId ? AVAILABLE_PRESETS.find((p) => p.id === presetId || p.id.startsWith(presetId)) : null;

  // 快捷模式：已传 discord-token + guild
  if (flags["discord-token"] && flags.guild) {
    if (presetId && !preset) fail(`Unknown preset: ${presetId}. Available: ${AVAILABLE_PRESETS.map((p) => p.id).join(", ")}`);
    // 默认 openclaw
    if (!preset) preset = AVAILABLE_PRESETS.find((p) => p.id === "openclaw");
    const targetId = flags.id ?? preset.id;
    const reg = readRegistry(flags);
    const existing = reg.agents.find((a) => a.id === targetId);
    if (existing) {
      const ok = await confirmOverwrite(existing, flags);
      if (!ok) {
        console.log(DIM("Cancelled. Existing agent kept."));
        return;
      }
    }
    await runPresetSetup(preset, flags);
    return;
  }

  // 交互模式
  banner();
  console.log(BOLD("  Agent Setup / Agent 配置\n"));
  console.log(DIM("  选择预设模板，填入 Discord 信息，自动完成配置。\n"));

  const rl = makeRl();
  try {
    if (!preset) {
      const presetIndex = await choose(rl, "选择 Agent 模板:",
        AVAILABLE_PRESETS.map((p) => {
          const label = `${BOLD(p.name.padEnd(13))} ${DIM(p.desc)}`;
          return label;
        })
      );
      preset = AVAILABLE_PRESETS[presetIndex];
    }
    console.log(`  ${GREEN("✓")} ${preset.name}\n`);

    // 提前检查：preset.id 是否已有配置
    const targetId = flags.id ?? preset.id;
    const reg = readRegistry(flags);
    const existing = reg.agents.find((a) => a.id === targetId);
    if (existing) {
      const ok = await confirmOverwrite(existing, flags, rl);
      if (!ok) {
        console.log(DIM("Cancelled. Existing agent kept."));
        return;
      }
    }

    // Discord 信息
    console.log(BOLD("  Discord 连接信息\n"));
    const discordToken = await ask(rl, "Discord Bot Token", { required: true, validate: (v) => v.length >= 20, invalidMsg: "Token 格式不对，至少20位" });
    const guildId = await ask(rl, "Discord 服务器 ID (右键服务器→复制ID)", { required: true, validate: (v) => /^\d{17,20}$/.test(v), invalidMsg: "服务器 ID 是 17-20 位数字" });
    const channel = await ask(rl, "语音频道名", { default: "General" });

    // 可选配置
    console.log(`\n${BOLD("  可选配置\n")}`);
    const wantStart = await confirm(rl, "配置完成后立即启动？", true);

    flags["discord-token"] = discordToken;
    flags.guild = guildId;
    flags.channel = channel;
    if (wantStart) flags.start = true;

    flags._rl = rl; // pass rl to setup functions for shared prompts
    await runPresetSetup(preset, flags);
  } finally {
    closeRl(rl);
  }
}

/** Route preset to the right setup handler. */
async function runPresetSetup(preset, flags) {
  flags.id = flags.id ?? preset.id;
  if (preset.needsOpenClawPath) {
    await setupOpenClawAgent(flags);
  } else if (preset.httpModes && !preset.cliCommand) {
    await setupHttpAgent(flags, preset);
  } else if (preset.cliCommand) {
    await setupGenericCliAgent(flags, preset);
  } else {
    fail(`Preset ${preset.id} has no setup handler.`);
  }
}

/** Setup a generic CLI-based agent (Claude Code, Codex, Trae Solo, etc.) */
async function setupGenericCliAgent(flags, preset) {
  const id = String(flags.id ?? preset.id);
  const directory = String(flags.directory ?? `agents/${id}`);
  const modulePath = `${directory.replace(/\\/g, "/")}/generic-cli-agent.js`;
  const agentDir = resolve(process.cwd(), directory);
  const channel = flags.channel ?? "General";
  const cliArgs = JSON.stringify(preset.cliArgs ?? ["-p"]);

  if (!flags["discord-token"]) fail("Missing --discord-token for Discord bot identity.");
  if (!flags.guild) fail("Missing --guild for Discord bot identity.");

  // Verify CLI command exists
  const cliPath = await discoverCliCommand(preset.cliCommand);
  if (!cliPath) {
    console.log(YELLOW(`  ⚠ ${preset.cliCommand} 未在 PATH 中找到，请确保已安装。`));
    console.log(DIM(`    将继续配置，但启动前需要确认 ${preset.cliCommand} 可用。`));
  }

  mkdirSync(agentDir, { recursive: true });
  writeAgentEnvIfConfigured(agentDir, { ...flags, channel });

  // Write agent-specific env
  const agentEnvPath = resolve(agentDir, ".env");
  const agentEnv = loadEnv(agentEnvPath);
  upsertEnvValues(agentEnvPath, {
    AGENT_CLI_COMMAND: preset.cliCommand,
    AGENT_CLI_ARGS: cliArgs,
    AGENT_CLI_JSON: preset.cliJson ? "true" : "false",
    ...(agentEnv["DISCORD_BOT_TOKEN"] ? {} : { DISCORD_BOT_TOKEN: flags["discord-token"] }),
    ...(agentEnv["GUILD_ID"] ? {} : { GUILD_ID: flags.guild }),
    ...(agentEnv["VOICE_CHANNEL_NAME"] ? {} : { VOICE_CHANNEL_NAME: channel }),
  });

  // Write generic CLI module
  const moduleFile = resolve(process.cwd(), modulePath);
  if (!existsSync(moduleFile) || flags.force) {
    writeFileSync(moduleFile, renderGenericCliModule(), "utf-8");
  }

  // Root .env provider keys
  const rootUpdates = cleanObject({
    GROQ_API_KEY: flags["groq-key"] ?? flags.groqKey,
    GROQ_STT_MODEL: flags["groq-stt-model"] ?? flags.groqSttModel ?? "whisper-large-v3",
    GROQ_STT_LANGUAGE: flags["groq-stt-language"] ?? flags.groqSttLanguage ?? "zh",
    MINIMAX_API_KEY: flags["minimax-key"] ?? flags.minimaxKey,
    MINIMAX_MODEL: flags["minimax-model"] ?? flags.minimaxModel ?? "speech-2.8-hd",
    MINIMAX_LLM_MODEL: flags["minimax-llm-model"] ?? flags.minimaxLlmModel ?? "MiniMax-M3",
  });
  upsertEnvValues(ENV_FILE, rootUpdates ?? {});

  // Register agent
  const registry = readRegistry(flags);
  const existingIndex = registry.agents.findIndex((agent) => agent.id === id);
  const existing = existingIndex >= 0 ? registry.agents[existingIndex] : undefined;
  const agentDef = cleanObject({
    id,
    type: "module",
    role: flags.role ?? preset.role,
    directory,
    displayName: flags.name ?? flags.displayName ?? preset.displayName,
    domains: parseList(flags.domains) ?? preset.domains,
    voiceId: flags.voice ?? flags.voiceId,
    ttsModel: flags.ttsModel ?? "speech-2.8-hd",
    timeoutMs: parseInteger(flags.timeoutMs) ?? 180000,
    transport: { module: modulePath },
    metadata: cleanObject({
      preset: preset.id,
      adapter: "generic-cli",
      cliCommand: preset.cliCommand,
      addedAt: existing?.metadata?.addedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  });

  const shouldSave = await runMatch(agentDef, flags, flags._rl);
  if (!shouldSave) {
    console.log(DIM("Cancelled. Configuration not saved."));
    return;
  }

  if (existingIndex >= 0) {
    registry.agents[existingIndex] = agentDef;
  } else {
    registry.agents.push(agentDef);
    registry.agents.sort((a, b) => a.id.localeCompare(b.id));
  }
  writeRegistry(registry, flags);

  console.log(`${GREEN(`Configured ${preset.name} agent`)} ${CYAN(id)}`);
  console.log(DIM(`  Registry: ${registry.path}`));
  console.log(DIM(`  Agent env: ${directory}/.env`));
  console.log(DIM(`  Module:    ${modulePath}`));
  console.log(DIM(`  Command:   ${preset.cliCommand} ${preset.cliArgs?.join(" ") ?? ""}`));

  const rootEnv = loadEnv(ENV_FILE);
  if (!rootEnv["GROQ_API_KEY"]) console.log(YELLOW("  Missing GROQ_API_KEY. STT will not work until it is configured."));
  if (!rootEnv["MINIMAX_API_KEY"]) console.log(YELLOW("  Missing MINIMAX_API_KEY. TTS will not work until it is configured."));

  if (flags.start) {
    return cmdAgentStart([id], flags);
  } else {
    console.log("");
    console.log(DIM(`Next: veynor agent start ${id}`));
  }
}

/** Setup an HTTP-based agent (Hermes serve, etc.) */
async function setupHttpAgent(flags, preset) {
  const id = String(flags.id ?? preset.id);
  const directory = String(flags.directory ?? `agents/${id}`);
  const agentDir = resolve(process.cwd(), directory);
  const channel = flags.channel ?? "General";

  if (!flags["discord-token"]) fail("Missing --discord-token for Discord bot identity.");
  if (!flags.guild) fail("Missing --guild for Discord bot identity.");

  // Ask for port interactively if not provided
  const rl = makeRl();
  let port = flags.port ?? "8788";
  try {
    console.log(BOLD(`\n  ${preset.name} HTTP 配置\n`));
    port = await ask(rl, "HTTP 服务端口", { default: "8788", validate: (v) => /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536, invalidMsg: "端口号范围 1-65535" });
  } finally {
    closeRl(rl);
  }

  const httpMode = preset.httpModes[0]; // default first mode
  const url = httpMode.url.replace("{port}", port);

  mkdirSync(agentDir, { recursive: true });
  writeAgentEnvIfConfigured(agentDir, { ...flags, channel });

  // Root .env provider keys
  const rootUpdates = cleanObject({
    GROQ_API_KEY: flags["groq-key"] ?? flags.groqKey,
    GROQ_STT_MODEL: flags["groq-stt-model"] ?? flags.groqSttModel ?? "whisper-large-v3",
    GROQ_STT_LANGUAGE: flags["groq-stt-language"] ?? flags.groqSttLanguage ?? "zh",
    MINIMAX_API_KEY: flags["minimax-key"] ?? flags.minimaxKey,
    MINIMAX_MODEL: flags["minimax-model"] ?? flags.minimaxModel ?? "speech-2.8-hd",
    MINIMAX_LLM_MODEL: flags["minimax-llm-model"] ?? flags.minimaxLlmModel ?? "MiniMax-M3",
  });
  upsertEnvValues(ENV_FILE, rootUpdates ?? {});

  // Register as HTTP type agent
  const registry = readRegistry(flags);
  const existingIndex = registry.agents.findIndex((agent) => agent.id === id);
  const existing = existingIndex >= 0 ? registry.agents[existingIndex] : undefined;
  const agentDef = cleanObject({
    id,
    type: "http",
    role: flags.role ?? preset.role,
    directory,
    displayName: flags.name ?? flags.displayName ?? preset.displayName,
    domains: parseList(flags.domains) ?? preset.domains,
    voiceId: flags.voice ?? flags.voiceId,
    ttsModel: flags.ttsModel ?? "speech-2.8-hd",
    timeoutMs: parseInteger(flags.timeoutMs) ?? 180000,
    transport: { url },
    metadata: cleanObject({
      preset: preset.id,
      adapter: "http",
      addedAt: existing?.metadata?.addedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  });

  const shouldSave = await runMatch(agentDef, flags, flags._rl);
  if (!shouldSave) {
    console.log(DIM("Cancelled. Configuration not saved."));
    return;
  }

  if (existingIndex >= 0) {
    registry.agents[existingIndex] = agentDef;
  } else {
    registry.agents.push(agentDef);
    registry.agents.sort((a, b) => a.id.localeCompare(b.id));
  }
  writeRegistry(registry, flags);

  console.log(`${GREEN(`Configured ${preset.name} agent (HTTP)`)} ${CYAN(id)}`);
  console.log(DIM(`  Registry: ${registry.path}`));
  console.log(DIM(`  Agent env: ${directory}/.env`));
  console.log(DIM(`  Endpoint:  ${url}`));
  console.log(YELLOW(`  Make sure "${preset.id} serve" is running on port ${port} before starting.`));

  if (flags.start) {
    return cmdAgentStart([id], flags);
  } else {
    console.log("");
    console.log(DIM(`Next: veynor agent start ${id}`));
  }
}

/** Discover if a CLI command exists in PATH. Returns path or null. */
async function discoverCliCommand(command) {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const path = await new Promise<string>((resolve, reject) => {
      execFile(cmd, [command], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.toString().trim().split("\n")[0]);
      });
    });
    return path || null;
  } catch {
    return null;
  }
}

async function setupOpenClawAgent(flags) {
  const id = String(flags.id ?? "openclaw");
  const directory = String(flags.directory ?? `agents/${id}`);
  const modulePath = `${directory.replace(/\\/g, "/")}/openclaw-agent.js`;
  const agentDir = resolve(process.cwd(), directory);
  const openclawPath = flags["openclaw-mjs"] ?? flags.openclawMjs ?? flags.openclawPath ?? flags.openclaw ?? await discoverOpenClawPath();
  const openclawAgent = String(flags["openclaw-agent"] ?? flags.openclawAgent ?? "main");
  const channel = flags.channel ?? "General";

  if (!flags["discord-token"]) fail("Missing --discord-token for OpenClaw Discord bot identity.");
  if (!flags.guild) fail("Missing --guild for OpenClaw Discord bot identity.");

  mkdirSync(agentDir, { recursive: true });
  writeAgentEnvIfConfigured(agentDir, {
    ...flags,
    channel,
  });
  const moduleFile = resolve(process.cwd(), modulePath);
  if (!existsSync(moduleFile) || flags.force) {
    writeFileSync(moduleFile, renderOpenClawModule(), "utf-8");
  }

  const rootUpdates = cleanObject({
    OPENCLAW_MJS: openclawPath,
    OPENCLAW_AGENT: openclawAgent,
    GROQ_API_KEY: flags["groq-key"] ?? flags.groqKey,
    GROQ_STT_MODEL: flags["groq-stt-model"] ?? flags.groqSttModel ?? "whisper-large-v3",
    GROQ_STT_LANGUAGE: flags["groq-stt-language"] ?? flags.groqSttLanguage ?? "zh",
    MINIMAX_API_KEY: flags["minimax-key"] ?? flags.minimaxKey,
    MINIMAX_MODEL: flags["minimax-model"] ?? flags.minimaxModel ?? "speech-2.8-hd",
    MINIMAX_LLM_MODEL: flags["minimax-llm-model"] ?? flags.minimaxLlmModel ?? "MiniMax-M3",
  });
  upsertEnvValues(ENV_FILE, rootUpdates ?? {});

  const registry = readRegistry(flags);
  const existingIndex = registry.agents.findIndex((agent) => agent.id === id);
  const existing = existingIndex >= 0 ? registry.agents[existingIndex] : undefined;
  const agent = cleanObject({
    id,
    type: "module",
    role: flags.role ?? "openclaw",
    directory,
    displayName: flags.name ?? flags.displayName ?? "OpenClaw",
    domains: parseList(flags.domains) ?? ["general", "voice"],
    voiceId: flags.voice ?? flags.voiceId,
    ttsModel: flags.ttsModel ?? "speech-2.8-hd",
    timeoutMs: parseInteger(flags.timeoutMs) ?? 180000,
    transport: { module: modulePath },
    metadata: cleanObject({
      preset: "openclaw",
      adapter: "openclaw-cli",
      addedAt: existing?.metadata?.addedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  });

  const shouldSave = await runMatch(agent, flags, flags._rl);
  if (!shouldSave) {
    console.log(DIM("Cancelled. Configuration not saved."));
    return;
  }

  if (existingIndex >= 0) {
    registry.agents[existingIndex] = agent;
  } else {
    registry.agents.push(agent);
    registry.agents.sort((a, b) => a.id.localeCompare(b.id));
  }
  writeRegistry(registry, flags);

  console.log(`${GREEN("Configured OpenClaw agent")} ${CYAN(id)}`);
  console.log(DIM(`  Registry: ${registry.path}`));
  console.log(DIM(`  Agent env: ${directory}/.env`));
  console.log(DIM(`  OpenClaw adapter: ${modulePath}`));

  const rootEnv = loadEnv(ENV_FILE);
  if (!rootEnv["OPENCLAW_MJS"]) console.log(YELLOW("  OPENCLAW_MJS not found. Install openclaw globally or pass --openclaw-mjs <path>."));
  if (!rootEnv["GROQ_API_KEY"]) console.log(YELLOW("  Missing GROQ_API_KEY. STT will not work until it is configured."));
  if (!rootEnv["MINIMAX_API_KEY"]) console.log(YELLOW("  Missing MINIMAX_API_KEY. TTS will not work until it is configured."));

  if (flags.start) {
    return cmdAgentStart([id], flags);
  } else {
    console.log("");
    console.log(DIM(`Next: veynor agent start ${id}`));
  }
}

function renderGenericCliModule() {
  return `import { execFile } from "node:child_process";

const DEFAULT_VOICE_PREFIX =
  "你是语音助手，回复会被朗读。请用简洁自然的中文口语回答，避免 Markdown 表格和长代码块。用户说：";

export function createAgent(definition) {
  const cliCommand = process.env.AGENT_CLI_COMMAND;
  if (!cliCommand) {
    throw new Error("AGENT_CLI_COMMAND is required. Check your agent .env file.");
  }

  let cliArgs;
  try {
    cliArgs = JSON.parse(process.env.AGENT_CLI_ARGS || '["-p"]');
  } catch {
    cliArgs = ["-p"];
  }

  const isJsonOutput = process.env.AGENT_CLI_JSON === "true";
  const voicePrefix = process.env.AGENT_VOICE_PREFIX || DEFAULT_VOICE_PREFIX;

  return {
    async chat(text, participantId, signal) {
      const message = voicePrefix + text;

      return new Promise((resolve, reject) => {
        const args = [...cliArgs, message];
        execFile(
          cliCommand,
          args,
          { maxBuffer: 10 * 1024 * 1024, windowsHide: true, signal },
          (err, stdout, stderr) => {
            if (err) {
              reject(new Error(\`\${cliCommand} failed: \${stderr?.toString().slice(-300) || err.message}\`));
              return;
            }
            let reply;
            try {
              if (isJsonOutput) {
                const data = JSON.parse(stdout);
                reply = data?.result?.payloads?.[0]?.text
                  ?? data?.text
                  ?? data?.content
                  ?? data?.reply
                  ?? "";
              } else {
                reply = stdout.toString().trim();
              }
              if (!reply) {
                reject(new Error(\`\${cliCommand} returned empty reply\`));
                return;
              }
              resolve(stripMarkdown(String(reply)));
            } catch {
              // If JSON expected but parse fails, use raw stdout
              if (isJsonOutput) {
                reply = stdout.toString().trim();
                if (reply) resolve(stripMarkdown(reply));
                else reject(new Error(\`\${cliCommand} returned invalid output\`));
              } else {
                reject(new Error(\`\${cliCommand} returned invalid output\`));
              }
            }
          },
        );
      });
    },
  };
}

function stripMarkdown(text) {
  return text
    .replace(/\`\`\`[\\s\\S]*?\`\`\`/g, "[代码]")
    .replace(/\`([^\`]+)\`/g, "$1")
    .replace(/\\*\\*([^*]+)\\*\\*/g, "$1")
    .replace(/\\*([^*]+)\\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, "$1")
    .replace(/^#{1,6}\\s+/gm, "")
    .replace(/^[-*+]\\s+/gm, "")
    .replace(/^\\d+\\.\\s+/gm, "")
    .replace(/\\n{2,}/g, "。")
    .replace(/\\n/g, "。")
    .trim();
}
`;
}

function renderOpenClawModule() {
  return `import { execFile } from "node:child_process";

const DEFAULT_VOICE_PREFIX =
  "你是语音助手，回复会被朗读。请用简洁自然的中文口语回答，避免 Markdown 表格和长代码块。用户说：";

export function createAgent(definition) {
  return {
    async chat(text, participantId, signal) {
      const openclawPath = process.env.OPENCLAW_MJS;
      if (!openclawPath) {
        throw new Error("OPENCLAW_MJS is required. Run: veynor agent setup openclaw --openclaw-mjs <path>");
      }

      const agentName = process.env.OPENCLAW_AGENT || "main";
      const voicePrefix = process.env.HERMES_VOICE_PREFIX || DEFAULT_VOICE_PREFIX;
      const sessionKey = \`session:\${definition.id}:\${participantId}\`;
      const message = voicePrefix + text;

      return new Promise((resolve, reject) => {
        execFile(
          "node",
          [openclawPath, "agent", "--agent", agentName, "--session-key", sessionKey, "--message", message, "--json"],
          {
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
            signal,
          },
          (err, stdout, stderr) => {
            if (err) {
              reject(new Error(\`OpenClaw failed: \${stderr?.toString().slice(-300) || err.message}\`));
              return;
            }
            try {
              const data = JSON.parse(stdout);
              const reply =
                data?.result?.payloads?.[0]?.text ??
                data?.payloads?.[0]?.text ??
                data?.meta?.finalAssistantVisibleText ??
                data?.result?.finalAssistantVisibleText ??
                data?.result?.finalAssistantRawText ??
                data?.text ??
                "";
              if (!reply) {
                reject(new Error(\`OpenClaw returned empty reply: \${stdout.slice(0, 200)}\`));
                return;
              }
              resolve(stripMarkdown(String(reply)));
            } catch {
              reject(new Error(\`OpenClaw returned non-JSON output: \${stdout.slice(0, 200)}\`));
            }
          },
        );
      });
    },
  };
}

function stripMarkdown(text) {
  return text
    .replace(/\`\`\`[\\s\\S]*?\`\`\`/g, "[代码]")
    .replace(/\`([^\`]+)\`/g, "$1")
    .replace(/\\*\\*([^*]+)\\*\\*/g, "$1")
    .replace(/\\*([^*]+)\\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, "$1")
    .replace(/^#{1,6}\\s+/gm, "")
    .replace(/^[-*+]\\s+/gm, "")
    .replace(/^\\d+\\.\\s+/gm, "")
    .replace(/\\n{2,}/g, "。")
    .replace(/\\n/g, "。")
    .trim();
}
`;
}

function upsertEnvValues(path, values) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== "");
  if (entries.length === 0) return;

  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const entry = entries.find(([key]) => key === match[1]);
    if (!entry) return line;
    seen.add(entry[0]);
    return `${entry[0]}=${entry[1]}`;
  });

  for (const [key, value] of entries) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  writeFileSync(path, `${next.filter((line, index) => line !== "" || index < next.length - 1).join("\n")}\n`, "utf-8");
}

async function cmdAgentStart(args, flags) {
  try {
    const mod = await import("./agent-start.js");
    return mod.cmdAgentStart(args, flags);
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND") {
      fail("agent-start module not found. Ensure bin/commands/agent-start.js exists.");
    }
    throw err;
  }
}

function cmdAgentEnv(args, flags) {
  const id = args[0] ?? flags.id;
  if (!id) fail("Missing agent id. Example: veynor agent env architect");

  const registry = readRegistry(flags);
  const agent = registry.agents.find((item) => item.id === id);
  if (!agent) fail(`Agent not found: ${id}`);

  if (!agent.directory) {
    console.log(DIM(`Agent ${id} has no directory. Only root .env available:`));
    console.log(JSON.stringify({ rootEnv: resolve(process.cwd(), ".env") }, null, 2));
    return;
  }

  const agentDir = resolve(process.cwd(), agent.directory);
  const merged = loadMergedEnv(agentDir);
  const complete = agentEnvIsComplete(merged);

  console.log(DIM(`Merged env for agent ${CYAN(id)} (root .env + ${agent.directory}/.env):`));
  console.log(DIM(`  Complete: ${complete ? GREEN("YES") : RED("NO — missing DISCORD_BOT_TOKEN, GUILD_ID, or VOICE_CHANNEL_NAME")}`));
  console.log("");
  // Print sanitized keys (mask tokens)
  for (const [key, value] of Object.entries(merged)) {
    const masked = key.toLowerCase().includes("token") || key.toLowerCase().includes("key")
      ? `${String(value).slice(0, 8)}...`
      : value;
    console.log(`  ${key}=${masked}`);
  }
}

async function discoverOpenClawPath() {
  // 1. env var
  const envPath = process.env["OPENCLAW_MJS"];
  if (envPath && existsSync(envPath)) return envPath;

  // 2. npm root -g
  try {
    const globalRoot = await new Promise<string>((resolve, reject) => {
      execFile("npm", ["root", "-g"], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.toString().trim());
      });
    });
    const candidate = resolve(globalRoot, "openclaw", "openclaw.mjs");
    if (existsSync(candidate)) return candidate;
  } catch {}

  // 3. common paths
  const candidates = [
    "D:\\npm-global\\node_modules\\openclaw\\openclaw.mjs",
    "C:\\npm-global\\node_modules\\openclaw\\openclaw.mjs",
    "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
    "./node_modules/openclaw/openclaw.mjs",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Display existing agent config and ask user whether to overwrite. Pass existing rl to share; otherwise opens its own. */
async function confirmOverwrite(existing, flags, rl = null) {
  if (!existing) return true;
  if (flags.force) return true;
  if (!process.stdin.isTTY) return true; // non-interactive (CI/script): proceed

  const useExistingRl = !!rl;
  const r = rl ?? makeRl();
  try {
    console.log("");
    console.log(YELLOW("  ⚠ Agent already configured:"));
    console.log(DIM(`     ID:           ${existing.id}`));
    console.log(DIM(`     Type:         ${existing.type}`));
    if (existing.role) console.log(DIM(`     Role:         ${existing.role}`));
    if (existing.directory) console.log(DIM(`     Directory:    ${existing.directory}`));
    if (existing.displayName) console.log(DIM(`     Display name: ${existing.displayName}`));
    if (existing.voiceId) console.log(DIM(`     Voice:        ${existing.voiceId}`));
    if (existing.timeoutMs) console.log(DIM(`     Timeout:      ${existing.timeoutMs}ms`));
    if (existing.transport?.url) console.log(DIM(`     URL:          ${existing.transport.url}`));
    if (existing.transport?.module) console.log(DIM(`     Module:       ${existing.transport.module}`));
    if (existing.transport?.command) console.log(DIM(`     Command:      ${existing.transport.command}`));
    if (existing.metadata?.preset) console.log(DIM(`     Preset:       ${existing.metadata.preset}`));
    if (existing.metadata?.adapter) console.log(DIM(`     Adapter:      ${existing.metadata.adapter}`));
    if (existing.metadata?.cliCommand) console.log(DIM(`     CLI:          ${existing.metadata.cliCommand}`));
    console.log("");
    return await confirm(r, "Overwrite existing configuration?", false);
  } finally {
    if (!useExistingRl) closeRl(r);
  }
}

/** Run the live match probe, show status, and (on failure) ask whether to save anyway. Returns true if should save. */
async function runMatch(agentDef, flags = {}, rl = null) {
  if (flags["skip-match"]) {
    console.log(DIM("  ⏭ 匹配已跳过 (--skip-match)"));
    return true;
  }
  const presetName = agentDef.metadata?.preset ?? agentDef.type;
  console.log("");
  console.log(`  ${YELLOW("⟳ 匹配中")}  ${DIM(`正在连接 ${presetName} ...`)}`);

  const result = await matchAgent(agentDef, flags);
  const dur = DIM(`(${result.durationMs}ms)`);
  if (result.ok) {
    console.log(`  ${GREEN("✓ 匹配成功")} ${dur}  ${result.detail}`);
    return true;
  }
  console.log(`  ${RED("✗ 匹配失败")} ${dur}  ${result.detail}`);
  console.log("");
  console.log(DIM("  配置可能有问题：网络不通、Token 无效、agent 进程未启动、CLI 路径错误等。"));

  if (flags.force) {
    console.log(DIM("  --force 已设置，强制保存配置。"));
    return true;
  }

  const useExistingRl = !!rl;
  const r = rl ?? makeRl();
  try {
    const save = await confirm(r, "匹配失败，是否仍要保存配置?", false);
    return save;
  } finally {
    if (!useExistingRl) closeRl(r);
  }
}

/** Live-match (probe) the agent's transport. Returns { ok, detail, durationMs }. */
async function matchAgent(agentDef, flags = {}) {
  const start = Date.now();
  const preset = agentDef.metadata?.preset;
  const type = agentDef.type;

  // HTTP type (Hermes, custom)
  if (type === "http") {
    const url = agentDef.transport?.url;
    if (!url) return { ok: false, detail: "no transport.url", durationMs: 0 };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "ping", sessionKey: "match:probe", agent: agentDef.id }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: true, detail: `HTTP ${res.status} · ${text.slice(0, 60).replace(/\n/g, " ")}`, durationMs: Date.now() - start };
      }
      return { ok: false, detail: `HTTP ${res.status}`, durationMs: Date.now() - start };
    } catch (err) {
      return { ok: false, detail: err.message || "fetch failed", durationMs: Date.now() - start };
    }
  }

  // Module type — try to actually invoke the agent with a ping
  if (type === "module") {
    const modulePath = agentDef.transport?.module;
    if (!modulePath) return { ok: false, detail: "no transport.module", durationMs: 0 };
    try {
      // Load module, call createAgent, call chat
      const url = pathToFileURL(resolve(process.cwd(), modulePath)).href;
      const loaded = await import(url);
      const factory = loaded.default ?? loaded.agent ?? loaded.createAgent;
      if (!factory) return { ok: false, detail: "module missing createAgent/default export", durationMs: 0 };
      const probe = typeof factory === "function" ? await factory(agentDef) : factory;
      if (!probe?.chat) return { ok: false, detail: "createAgent() did not return an object with chat()", durationMs: 0 };
      const reply = await probe.chat("ping", "match:probe", AbortSignal.timeout(30000));
      const ok = typeof reply === "string" && reply.length > 0;
      return { ok, detail: ok ? `Replied: "${reply.slice(0, 60).replace(/\n/g, " ")}"` : "empty reply", durationMs: Date.now() - start };
    } catch (err) {
      return { ok: false, detail: err.message || "module import/chat failed", durationMs: Date.now() - start };
    }
  }

  // Stdio type
  if (type === "stdio") {
    return new Promise((resolve) => {
      const cmd = agentDef.transport?.command;
      if (!cmd) return resolve({ ok: false, detail: "no transport.command", durationMs: 0 });
      const args = (agentDef.transport?.args ?? []).concat("ping");
      execFile(cmd, args, { timeout: 30000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve({ ok: false, detail: err.message, durationMs: Date.now() - start });
        const reply = stdout.toString().trim();
        resolve({ ok: reply.length > 0, detail: reply ? `Output: "${reply.slice(0, 60).replace(/\n/g, " ")}"` : "empty output", durationMs: Date.now() - start });
      });
    });
  }

  return { ok: false, detail: `unsupported type: ${type}`, durationMs: 0 };
}

function fail(message) {
  console.error(RED(message));
  process.exit(1);
}
