import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { readAgentRegistry } from "./agent.js";
import { CYAN, DIM, GREEN, RED, YELLOW } from "../lib/ui.js";

const DEFAULT_MEETING_PATH = ".veynor/meeting.json";

export function cmdMeeting(positional, flags) {
  if (flags.help) {
    showMeetingHelp();
    return;
  }

  const action = positional[0] ?? "status";

  switch (action) {
    case "select":
    case "invite":
      selectAgents(positional.slice(1), flags);
      return;
    case "status":
      showMeetingStatus(flags);
      return;
    case "agents":
      listMeetingCandidates(flags);
      return;
    case "clear":
      clearMeeting(flags);
      return;
    case "start":
    case "prepare":
      prepareMeeting(positional.slice(1), flags);
      return;
    case "help":
    case "-h":
    case "--help":
      showMeetingHelp();
      return;
    default:
      console.error(`${RED("Unknown meeting command:")} ${action}\n`);
      showMeetingHelp();
      process.exit(1);
  }
}

export function selectMeetingAgents(agentIds, flags = {}) {
  const selected = normalizeAgentIds(agentIds.length > 0 ? agentIds : parseAgentFlag(flags.agents));
  if (selected.length === 0) fail("No agents selected. Example: veynor meeting select hermes codex openclaw");

  const registry = readAgentRegistry(flags);
  const registered = new Set(registry.agents.map((agent) => agent.id));
  const missing = selected.filter((id) => !registered.has(id));
  if (missing.length > 0) {
    fail(`Unknown agent(s): ${missing.join(", ")}. Run: veynor agent list`);
  }

  const meeting = {
    version: 1,
    selectedAgentIds: selected,
    updatedAt: new Date().toISOString(),
  };
  writeMeeting(meeting, flags);
  return { meeting, path: meetingPath(flags) };
}

export function readMeetingSelection(flags = {}) {
  const path = meetingPath(flags);
  if (!existsSync(path)) {
    return { version: 1, path, selectedAgentIds: [], updatedAt: null };
  }
  const data = JSON.parse(readFileSync(path, "utf-8"));
  return {
    version: data.version ?? 1,
    path,
    selectedAgentIds: Array.isArray(data.selectedAgentIds) ? data.selectedAgentIds : [],
    updatedAt: data.updatedAt ?? null,
  };
}

function selectAgents(args, flags) {
  const { meeting, path } = selectMeetingAgents(args, flags);
  console.log(`${GREEN("Selected meeting agents")} ${CYAN(meeting.selectedAgentIds.join(", "))}`);
  console.log(DIM(`Saved to ${path}`));
}

function showMeetingStatus(flags) {
  const registry = readAgentRegistry(flags);
  const meeting = readMeetingSelection(flags);
  const registered = new Map(registry.agents.map((agent) => [agent.id, agent]));

  console.log(DIM(`Meeting: ${meeting.path}\n`));
  if (meeting.selectedAgentIds.length === 0) {
    console.log(DIM("No agents selected for the current meeting."));
    console.log(DIM("Select agents with: veynor meeting select hermes codex openclaw"));
    return;
  }

  for (const id of meeting.selectedAgentIds) {
    const agent = registered.get(id);
    if (!agent) {
      console.log(`${RED(id)} ${DIM("(missing from registry)")}`);
      continue;
    }
    const voice = agent.voiceId ? ` voice=${agent.voiceId}` : "";
    console.log(`${CYAN(id.padEnd(18))} ${YELLOW(agent.type.padEnd(6))} ${agent.role}${voice}`);
  }
}

function listMeetingCandidates(flags) {
  const registry = readAgentRegistry(flags);
  const meeting = readMeetingSelection(flags);
  const selected = new Set(meeting.selectedAgentIds);

  if (registry.agents.length === 0) {
    console.log(DIM("No registered agents. Add one with: veynor agent add <id> ..."));
    return;
  }

  for (const agent of registry.agents) {
    const mark = selected.has(agent.id) ? "*" : " ";
    const voice = agent.voiceId ? ` voice=${agent.voiceId}` : "";
    console.log(`${mark} ${CYAN(agent.id.padEnd(18))} ${YELLOW(agent.type.padEnd(6))} ${agent.role}${voice}`);
  }
}

function clearMeeting(flags) {
  const meeting = { version: 1, selectedAgentIds: [], updatedAt: new Date().toISOString() };
  writeMeeting(meeting, flags);
  console.log(GREEN("Cleared current meeting agent selection"));
}

function prepareMeeting(args, flags) {
  const selected = normalizeAgentIds(args.length > 0 ? args : parseAgentFlag(flags.agents));
  const result = selected.length > 0 ? selectMeetingAgents(selected, flags) : { meeting: readMeetingSelection(flags), path: meetingPath(flags) };
  if (result.meeting.selectedAgentIds.length === 0) {
    fail("No meeting agents selected. Run: veynor meeting select <agent...>");
  }
  validateMeetingSelection(result.meeting.selectedAgentIds, flags);

  console.log(`${GREEN("Meeting selection ready")} ${CYAN(result.meeting.selectedAgentIds.join(", "))}`);
  console.log(DIM(`Saved to ${result.path}`));
  console.log(DIM("Start the host with: veynor start"));
}

function showMeetingHelp() {
  console.log("Veynor meeting selection / 会议 agent 选择");
  console.log("");
  console.log("Commands / 命令:");
  console.log("  veynor meeting agents");
  console.log("  veynor meeting select hermes codex openclaw");
  console.log("  veynor meeting status");
  console.log("  veynor meeting clear");
  console.log("  veynor meeting prepare --agents hermes,codex,openclaw");
  console.log("  veynor meeting start --agents hermes,codex,openclaw");
  console.log("");
  console.log("Flags / 参数:");
  console.log("  --registry <path>  Agent 注册表路径，默认 .veynor/agents.json");
  console.log("  --meeting <path>   会议选择文件，默认 .veynor/meeting.json");
  console.log("  --agents a,b,c     逗号分隔的 agent 列表");
  console.log("");
  console.log("Files / 文件:");
  console.log("  .veynor/agents.json   Registered local agents");
  console.log("  .veynor/meeting.json  Current meeting selection");
  console.log("");
  console.log("Examples / 示例:");
  console.log("  veynor meeting agents");
  console.log("  veynor meeting select architect critic planner");
  console.log("  veynor start --agents architect,critic,planner");
}

function writeMeeting(meeting, flags) {
  const path = meetingPath(flags);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: meeting.version, selectedAgentIds: meeting.selectedAgentIds, updatedAt: meeting.updatedAt }, null, 2)}\n`, "utf-8");
}

function meetingPath(flags) {
  return resolve(process.cwd(), flags.meeting ?? DEFAULT_MEETING_PATH);
}

function parseAgentFlag(value) {
  if (!value) return [];
  return String(value).split(",");
}

function normalizeAgentIds(values) {
  return [...new Set(values.flatMap((value) => String(value).split(",")).map((value) => value.trim()).filter(Boolean))];
}

function validateMeetingSelection(selectedAgentIds, flags) {
  const registry = readAgentRegistry(flags);
  const registered = new Set(registry.agents.map((agent) => agent.id));
  const missing = selectedAgentIds.filter((id) => !registered.has(id));
  if (missing.length > 0) {
    fail(`Meeting selection contains unknown agent(s): ${missing.join(", ")}. Run: veynor meeting select <agent...>`);
  }
}

function fail(message) {
  console.error(RED(message));
  process.exit(1);
}
