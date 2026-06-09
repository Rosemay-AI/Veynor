import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { CYAN, DIM, GREEN, RED, YELLOW } from "../lib/ui.js";
import { readAgentRegistry, writeAgentRegistry } from "./agent.js";

const DEFAULT_VOICE_REGISTRY_PATH = ".veynor/voices.json";
const SUPPORTED_TYPES = new Set(["official", "custom", "clone"]);

export function cmdVoice(positional, flags) {
  if (flags.help) {
    showVoiceHelp();
    return;
  }

  const action = positional[0] ?? "list";

  switch (action) {
    case "add":
      addVoice(positional.slice(1), flags);
      return;
    case "official":
      addOfficialVoice(positional.slice(1), flags);
      return;
    case "custom":
      addCustomVoice(positional.slice(1), flags);
      return;
    case "clone":
      addCloneVoice(positional.slice(1), flags);
      return;
    case "list":
    case "ls":
      listVoices(flags);
      return;
    case "show":
      showVoice(positional.slice(1), flags);
      return;
    case "use":
      useVoice(positional.slice(1), flags);
      return;
    case "remove":
    case "rm":
      removeVoice(positional.slice(1), flags);
      return;
    case "export":
      exportVoices(flags);
      return;
    case "help":
    case "-h":
    case "--help":
      showVoiceHelp();
      return;
    default:
      console.error(`${RED("Unknown voice command:")} ${action}\n`);
      showVoiceHelp();
      process.exit(1);
  }
}

function addOfficialVoice(args, flags) {
  addVoice(args, { ...flags, type: "official" });
}

function addCustomVoice(args, flags) {
  addVoice(args, { ...flags, type: "custom" });
}

function addCloneVoice(args, flags) {
  addVoice(args, { ...flags, type: "clone" });
}

function addVoice(args, flags) {
  const id = args[0] ?? flags.id;
  if (!id) fail("Missing voice id. Example: veynor voice official female --provider minimax --providerVoiceId female-shaonv");

  const type = String(flags.type ?? "official");
  if (!SUPPORTED_TYPES.has(type)) fail(`Unsupported voice type: ${type}. Use official, custom, or clone.`);

  const registry = readVoiceRegistry(flags);
  const existingIndex = registry.voices.findIndex((voice) => voice.id === id);
  const now = new Date().toISOString();

  const provider = flags.provider ?? "minimax";
  const providerVoiceId = flags.providerVoiceId ?? flags.voiceId ?? id;

  const voice = cleanObject({
    id,
    type,
    provider,
    providerVoiceId,
    displayName: flags.name ?? flags.displayName,
    zhName: flags.zhName ?? flags["zh-name"],
    description: flags.description,
    zhDescription: flags.zhDescription ?? flags["zh-description"],
    comment: flags.comment,
    language: flags.language,
    model: flags.model,
    speed: parseNumber(flags.speed),
    volume: parseNumber(flags.volume),
    pitch: parseNumber(flags.pitch),
    clone: type === "clone" ? cleanObject({
      status: flags.status ?? "pending",
      source: flags.source,
      fileId: flags.fileId,
      consent: parseBoolean(flags.consent),
      notes: flags.notes,
    }) : undefined,
    metadata: cleanObject({
      addedAt: existingIndex >= 0 ? registry.voices[existingIndex].metadata?.addedAt : now,
      updatedAt: now,
    }),
  });

  validateVoice(voice);

  if (existingIndex >= 0) {
    registry.voices[existingIndex] = voice;
    writeVoiceRegistry(registry, flags);
    console.log(`${GREEN("Updated voice")} ${CYAN(id)} ${DIM(`in ${registry.path}`)}`);
    return;
  }

  registry.voices.push(voice);
  registry.voices.sort((a, b) => a.id.localeCompare(b.id));
  writeVoiceRegistry(registry, flags);
  console.log(`${GREEN("Added voice")} ${CYAN(id)} ${DIM(`to ${registry.path}`)}`);
}

function listVoices(flags) {
  const registry = readVoiceRegistry(flags);
  if (registry.voices.length === 0) {
    console.log(DIM(`No voices registered in ${registry.path}`));
    console.log(DIM("Add one with: veynor voice official female --providerVoiceId female-shaonv"));
    return;
  }

  console.log(DIM(`Voice registry: ${registry.path}\n`));
  for (const voice of registry.voices) {
    const provider = voice.provider ?? "minimax";
    const providerVoiceId = voice.providerVoiceId ?? voice.id;
    const model = voice.model ? ` model=${voice.model}` : "";
    const status = voice.clone?.status ? ` status=${voice.clone.status}` : "";
    console.log(`${CYAN(voice.id.padEnd(18))} ${YELLOW(voice.type.padEnd(8))} ${provider}:${providerVoiceId}${model}${status}`);
    const label = voice.zhName ?? voice.displayName;
    const description = voice.zhDescription ?? voice.description ?? voice.comment;
    if (label || description) {
      console.log(`  ${DIM([label, description].filter(Boolean).join(" - "))}`);
    }
  }
}

function showVoice(args, flags) {
  const id = args[0] ?? flags.id;
  if (!id) fail("Missing voice id. Example: veynor voice show female");
  const registry = readVoiceRegistry(flags);
  const voice = registry.voices.find((item) => item.id === id);
  if (!voice) fail(`Voice not found: ${id}`);
  console.log(JSON.stringify(voice, null, 2));
}

function useVoice(args, flags) {
  const agentId = args[0] ?? flags.agent;
  const voiceId = args[1] ?? flags.voice ?? flags.voiceId;
  if (!agentId || !voiceId) fail("Usage: veynor voice use <agent-id> <voice-id>");

  const voices = readVoiceRegistry(flags);
  const voice = voices.voices.find((item) => item.id === voiceId);
  if (!voice) fail(`Voice not found: ${voiceId}`);

  const agents = readAgentRegistry(flags);
  const agent = agents.agents.find((item) => item.id === agentId);
  if (!agent) fail(`Agent not found: ${agentId}`);

  const nextAgent = {
    ...agent,
    voiceId: voice.providerVoiceId ?? voice.id,
    metadata: {
    ...(agent.metadata ?? {}),
    updatedAt: new Date().toISOString(),
    voiceProfileId: voice.id,
    },
  };
  if (voice.model) nextAgent.ttsModel = voice.model;
  if (voice.speed !== undefined) nextAgent.ttsSpeed = voice.speed;
  if (voice.volume !== undefined) nextAgent.ttsVolume = voice.volume;
  if (voice.pitch !== undefined) nextAgent.ttsPitch = voice.pitch;

  agents.agents = agents.agents.map((item) => item.id === agentId ? nextAgent : item);
  writeAgentRegistry(agents, flags);
  console.log(`${GREEN("Assigned voice")} ${CYAN(voice.id)} ${DIM(`(${nextAgent.voiceId})`)} ${GREEN("to agent")} ${CYAN(nextAgent.id)}`);
}

function removeVoice(args, flags) {
  const id = args[0] ?? flags.id;
  if (!id) fail("Missing voice id. Example: veynor voice remove female");
  const registry = readVoiceRegistry(flags);
  const next = registry.voices.filter((voice) => voice.id !== id);
  if (next.length === registry.voices.length) fail(`Voice not found: ${id}`);
  registry.voices = next;
  writeVoiceRegistry(registry, flags);
  console.log(`${GREEN("Removed voice")} ${CYAN(id)} ${DIM(`from ${registry.path}`)}`);
}

function exportVoices(flags) {
  const registry = readVoiceRegistry(flags);
  console.log(JSON.stringify({ version: registry.version, voices: registry.voices }, null, 2));
}

function showVoiceHelp() {
  console.log("Veynor voice registry / 音色管理");
  console.log("");
  console.log("Commands / 命令:");
  console.log("  veynor voice official <id> --providerVoiceId <minimax-voice-id>");
  console.log("  veynor voice custom <id> --providerVoiceId <voice-id> --name \"My Voice\"");
  console.log("  veynor voice clone <id> --source ./sample.wav --consent true --zh-name \"主持人\"");
  console.log("  veynor voice use <agent-id> <voice-id>");
  console.log("  veynor voice list");
  console.log("  veynor voice show <id>");
  console.log("  veynor voice remove <id>");
  console.log("  veynor voice export");
  console.log("");
  console.log("Common flags / 常用参数:");
  console.log("  --voice-registry <path>  音色库路径，默认 .veynor/voices.json");
  console.log("  --registry <path>        Agent 注册表路径，默认 .veynor/agents.json");
  console.log("  --provider minimax       音色服务商，目前推荐 minimax");
  console.log("  --providerVoiceId <id>   服务商音色 ID，TTS 实际使用这个值");
  console.log("  --name <text>            英文/通用名称");
  console.log("  --zh-name <text>         中文名称，例如 少女音、旁白、主持人");
  console.log("  --description <text>     英文/通用说明");
  console.log("  --zh-description <text>  中文说明，例如 温柔清晰，适合中文助手");
  console.log("  --comment <text>         备注，记录用途、来源或克隆状态");
  console.log("  --model <model>          TTS 模型，默认由运行时继承");
  console.log("  --speed <n>              语速覆盖");
  console.log("  --volume <n>             音量覆盖");
  console.log("  --pitch <n>              音高覆盖");
  console.log("  --source <path>          克隆源音频路径，仅记录工作流信息");
  console.log("  --fileId <id>            服务商上传文件 ID，用于克隆工作流");
  console.log("  --consent true           登记克隆音色时必须显式确认授权");
  console.log("");
  console.log("Examples / 示例:");
  console.log("  veynor voice official assistant --providerVoiceId female-shaonv --zh-name \"中文女声\" --zh-description \"温柔清晰，适合默认助手\"");
  console.log("  veynor voice custom narrator --providerVoiceId your_voice_id --zh-name \"旁白\" --comment \"用于长文本朗读\"");
  console.log("  veynor voice use architect assistant");
}

function readVoiceRegistry(flags) {
  const path = voiceRegistryPath(flags);
  if (!existsSync(path)) {
    return { version: 1, path, voices: [] };
  }

  const data = JSON.parse(readFileSync(path, "utf-8"));
  return {
    version: data.version ?? 1,
    path,
    voices: Array.isArray(data.voices) ? data.voices : [],
  };
}

function writeVoiceRegistry(registry, flags) {
  const path = voiceRegistryPath(flags);
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomically(path, { version: registry.version ?? 1, voices: registry.voices });
}

function writeJsonAtomically(path, data) {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, path);
}

function voiceRegistryPath(flags) {
  return resolve(process.cwd(), flags.voiceRegistry ?? flags["voice-registry"] ?? DEFAULT_VOICE_REGISTRY_PATH);
}

function validateVoice(voice) {
  if (!voice.provider) fail("Voice requires provider");
  if (!voice.providerVoiceId) fail("Voice requires providerVoiceId");
  if (voice.type === "clone" && voice.clone?.consent !== true) {
    fail("Clone voice registration requires --consent true");
  }
}

function parseNumber(value) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`Expected number, got ${value}`);
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

function fail(message) {
  console.error(RED(message));
  process.exit(1);
}
