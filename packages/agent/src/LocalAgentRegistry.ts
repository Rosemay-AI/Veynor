import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ParticipantId } from "@veynor/core";
import type { Agent } from "./types.js";
import type { RoundtableAgent, RoundtableFloorRequestContext, RoundtableFloorRequestProposal } from "./RoundtableRuntime.js";

export type LocalAgentTransport =
  | { url: string; command?: never; module?: never; cwd?: string }
  | { command: string; args?: string[]; shell?: boolean; url?: never; module?: never; cwd?: string }
  | { module: string; url?: never; command?: never; cwd?: string };

export type LocalAgentDefinition = {
  id: string;
  type: "http" | "stdio" | "module";
  role: string;
  /** Relative path to the agent's self-contained directory (e.g. "agents/architect"). */
  directory?: string;
  displayName?: string;
  domains?: string[];
  voiceId?: string;
  ttsModel?: string;
  ttsSpeed?: number;
  ttsVolume?: number;
  ttsPitch?: number;
  maxSpeakMs?: number;
  canChallenge?: boolean;
  canSummarize?: boolean;
  floorRequests?: LocalFloorRequestRule[];
  timeoutMs?: number;
  transport: LocalAgentTransport;
};

export type LocalFloorRequestRule = RoundtableFloorRequestProposal & {
  round?: number;
  afterAgentId?: string;
  afterIntent?: string;
  whenTranscriptIncludes?: string;
};

export type LocalAgentRegistry = {
  version: number;
  agents: LocalAgentDefinition[];
};

export type MeetingSelection = {
  version: number;
  selectedAgentIds: string[];
  updatedAt?: string | null;
};

export type LoadLocalRoundtableAgentsOptions = {
  cwd?: string;
  registryPath?: string;
  meetingPath?: string;
  agentIds?: string[];
};

const DEFAULT_REGISTRY_PATH = ".veynor/agents.json";
const DEFAULT_MEETING_PATH = ".veynor/meeting.json";

export async function loadLocalRoundtableAgents(
  options: LoadLocalRoundtableAgentsOptions = {},
): Promise<RoundtableAgent[]> {
  const cwd = options.cwd ?? process.cwd();
  const registry = loadLocalAgentRegistry({ cwd, registryPath: options.registryPath });
  const selectedAgentIds = options.agentIds ?? loadMeetingSelection({ cwd, meetingPath: options.meetingPath }).selectedAgentIds;
  const wanted = selectedAgentIds.length > 0 ? new Set(selectedAgentIds) : null;
  const agents = wanted ? registry.agents.filter((agent) => wanted.has(agent.id)) : registry.agents;

  if (wanted) {
    const found = new Set(agents.map((agent) => agent.id));
    const missing = selectedAgentIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw new Error(`Selected agent(s) not found in registry: ${missing.join(", ")}`);
  }

  return Promise.all(agents.map((definition) => toRoundtableAgent(definition, cwd)));
}

export function loadLocalAgentRegistry(options: { cwd?: string; registryPath?: string } = {}): LocalAgentRegistry {
  const path = resolve(options.cwd ?? process.cwd(), options.registryPath ?? DEFAULT_REGISTRY_PATH);
  if (!existsSync(path)) return { version: 2, agents: [] };

  const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<LocalAgentRegistry>;
  const agents = Array.isArray(data.agents) ? data.agents.map((agent, index) => normalizeLocalAgentDefinition(agent, index)) : [];
  return {
    version: data.version ?? 2,
    agents,
  };
}

function normalizeLocalAgentDefinition(value: unknown, index: number): LocalAgentDefinition {
  if (!isRecord(value)) throw new Error(`Agent registry entry #${index + 1} must be an object`);
  const id = requireString(value.id, `agents[${index}].id`);
  const type = requireAgentType(value.type, `agents[${index}].type`);
  const role = requireString(value.role, `agents[${index}].role`);
  const transport = normalizeTransport(value.transport, type, id, index);

  return {
    id,
    type,
    role,
    directory: optionalString(value.directory, `agents[${index}].directory`),
    displayName: optionalString(value.displayName, `agents[${index}].displayName`),
    domains: optionalStringArray(value.domains, `agents[${index}].domains`),
    voiceId: optionalString(value.voiceId, `agents[${index}].voiceId`),
    ttsModel: optionalString(value.ttsModel, `agents[${index}].ttsModel`),
    ttsSpeed: optionalNumber(value.ttsSpeed, `agents[${index}].ttsSpeed`),
    ttsVolume: optionalNumber(value.ttsVolume, `agents[${index}].ttsVolume`),
    ttsPitch: optionalNumber(value.ttsPitch, `agents[${index}].ttsPitch`),
    maxSpeakMs: optionalNumber(value.maxSpeakMs, `agents[${index}].maxSpeakMs`),
    canChallenge: optionalBoolean(value.canChallenge, `agents[${index}].canChallenge`),
    canSummarize: optionalBoolean(value.canSummarize, `agents[${index}].canSummarize`),
    floorRequests: normalizeFloorRequests(value.floorRequests, index),
    timeoutMs: optionalNumber(value.timeoutMs, `agents[${index}].timeoutMs`),
    transport,
  };
}

function normalizeTransport(value: unknown, type: LocalAgentDefinition["type"], id: string, index: number): LocalAgentTransport {
  const prefix = `agents[${index}].transport`;
  if (!isRecord(value)) throw new Error(`${prefix} for agent ${id} must be an object`);
  const cwd = optionalString(value.cwd, `${prefix}.cwd`);
  if (type === "http") return { url: requireString(value.url, `${prefix}.url`), cwd };
  if (type === "stdio") {
    return {
      command: requireString(value.command, `${prefix}.command`),
      args: optionalStringArray(value.args, `${prefix}.args`),
      shell: optionalBoolean(value.shell, `${prefix}.shell`),
      cwd,
    };
  }
  return { module: requireString(value.module, `${prefix}.module`), cwd };
}

function normalizeFloorRequests(value: unknown, agentIndex: number): LocalFloorRequestRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`agents[${agentIndex}].floorRequests must be an array`);
  return value.map((rule, index) => {
    const prefix = `agents[${agentIndex}].floorRequests[${index}]`;
    if (!isRecord(rule)) throw new Error(`${prefix} must be an object`);
    return {
      intent: requireString(rule.intent, `${prefix}.intent`) as LocalFloorRequestRule["intent"],
      reason: requireString(rule.reason, `${prefix}.reason`),
      priority: optionalNumber(rule.priority, `${prefix}.priority`),
      maxSpeakMs: optionalNumber(rule.maxSpeakMs, `${prefix}.maxSpeakMs`),
      round: optionalNumber(rule.round, `${prefix}.round`),
      afterAgentId: optionalString(rule.afterAgentId, `${prefix}.afterAgentId`),
      afterIntent: optionalString(rule.afterIntent, `${prefix}.afterIntent`),
      whenTranscriptIncludes: optionalString(rule.whenTranscriptIncludes, `${prefix}.whenTranscriptIncludes`),
    };
  });
}

function requireAgentType(value: unknown, path: string): LocalAgentDefinition["type"] {
  if (value === "http" || value === "stdio" || value === "module") return value;
  throw new Error(`${path} must be one of: http, stdio, module`);
}

function requireString(value: unknown, path: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(`${path} must be a non-empty string`);
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new Error(`${path} must be a string`);
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new Error(`${path} must be an array of strings`);
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${path} must be a finite number`);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new Error(`${path} must be a boolean`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadMeetingSelection(options: { cwd?: string; meetingPath?: string } = {}): MeetingSelection {
  const path = resolve(options.cwd ?? process.cwd(), options.meetingPath ?? DEFAULT_MEETING_PATH);
  if (!existsSync(path)) return { version: 1, selectedAgentIds: [], updatedAt: null };

  const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<MeetingSelection>;
  return {
    version: data.version ?? 1,
    selectedAgentIds: Array.isArray(data.selectedAgentIds) ? data.selectedAgentIds : [],
    updatedAt: data.updatedAt ?? null,
  };
}

async function toRoundtableAgent(definition: LocalAgentDefinition, cwd: string): Promise<RoundtableAgent> {
  return {
    id: definition.id,
    role: definition.role,
    displayName: definition.displayName,
    domains: definition.domains,
    voiceId: definition.voiceId,
    ttsModel: definition.ttsModel,
    ttsSpeed: definition.ttsSpeed,
    ttsVolume: definition.ttsVolume,
    ttsPitch: definition.ttsPitch,
    maxSpeakMs: definition.maxSpeakMs,
    canChallenge: definition.canChallenge,
    canSummarize: definition.canSummarize,
    agent: await createAgentAdapter(definition, cwd),
    requestFloor: definition.floorRequests?.length ? createRuleBasedFloorRequester(definition.floorRequests) : undefined,
  };
}

function createRuleBasedFloorRequester(
  rules: LocalFloorRequestRule[],
): (context: RoundtableFloorRequestContext) => Promise<RoundtableFloorRequestProposal[]> {
  return async (context) =>
    rules
      .filter((rule) => floorRequestRuleMatches(rule, context))
      .map((rule) => ({
        intent: rule.intent,
        reason: rule.reason,
        priority: rule.priority,
        maxSpeakMs: rule.maxSpeakMs,
      }));
}

function floorRequestRuleMatches(rule: LocalFloorRequestRule, context: RoundtableFloorRequestContext): boolean {
  if (rule.round !== undefined && rule.round !== context.round) return false;
  if (rule.afterAgentId && rule.afterAgentId !== context.lastSpeech?.agentId) return false;
  if (rule.afterIntent && rule.afterIntent !== context.lastSpeech?.grant.intent) return false;
  if (rule.whenTranscriptIncludes) {
    const transcript = context.transcript.map((entry) => entry.text).join("\n").toLowerCase();
    if (!transcript.includes(rule.whenTranscriptIncludes.toLowerCase())) return false;
  }
  return true;
}

export async function createAgentAdapter(definition: LocalAgentDefinition, cwd: string): Promise<Agent> {
  if (definition.type === "http") return createHttpAgent(definition);
  if (definition.type === "stdio") return createStdioAgent(definition, cwd);
  if (definition.type === "module") return createModuleAgent(definition, cwd);
  throw new Error(`Unsupported local agent type: ${(definition as { type: string }).type}`);
}

function createHttpAgent(definition: LocalAgentDefinition): Agent {
  const url = definition.transport.url;
  if (!url) throw new Error(`HTTP agent ${definition.id} requires transport.url`);
  const timeoutMs = definition.timeoutMs ?? 120_000;

  return {
    async chat(text, participantId, signal) {
      const requestSignal = createTimeoutSignal(signal, timeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, participantId, agentId: definition.id }),
          signal: requestSignal.signal,
        });
        if (!response.ok) throw new Error(`HTTP agent ${definition.id} failed: ${response.status} ${response.statusText}`);
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const data = await response.json();
          return extractAgentText(data, definition.id);
        }
        return response.text();
      } finally {
        requestSignal.dispose();
      }
    },
  };
}

function createStdioAgent(definition: LocalAgentDefinition, cwd: string): Agent {
  const transport = definition.transport as Extract<LocalAgentTransport, { command: string }>;
  const command = transport.command;
  if (!command) throw new Error(`stdio agent ${definition.id} requires transport.command`);
  const workingDirectory = resolve(cwd, transport.cwd ?? ".");
  const timeoutMs = definition.timeoutMs ?? 120_000;

  return {
    chat(text, participantId, signal) {
      return runStdioAgent({
        command,
        args: transport.args,
        shell: transport.shell,
        cwd: workingDirectory,
        input: { text, participantId, agentId: definition.id },
        signal,
        timeoutMs,
        agentId: definition.id,
      });
    },
  };
}

async function createModuleAgent(definition: LocalAgentDefinition, cwd: string): Promise<Agent> {
  const modulePath = definition.transport.module;
  if (!modulePath) throw new Error(`module agent ${definition.id} requires transport.module`);

  const loaded = await import(pathToFileURL(resolve(cwd, modulePath)).href);
  const candidate = loaded.default ?? loaded.agent ?? (await loaded.createAgent?.(definition));
  if (!candidate?.chat || typeof candidate.chat !== "function") {
    throw new Error(`module agent ${definition.id} must export an Agent or createAgent()`);
  }
  return candidate as Agent;
}

function runStdioAgent(options: {
  command: string;
  args?: string[];
  shell?: boolean;
  cwd: string;
  input: { text: string; participantId: ParticipantId; agentId: string };
  signal?: AbortSignal;
  timeoutMs: number;
  agentId: string;
}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const commandParts = options.args ? [options.command, ...options.args] : splitCommand(options.command);
    const [file, ...args] = commandParts;
    if (!file) {
      reject(new Error(`stdio agent ${options.agentId} has empty command`));
      return;
    }

    let settled = false;
    let child: ChildProcess | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const killChild = () => {
      if (!child) return;
      try {
        child.kill("SIGKILL");
      } catch {
        try {
          child.kill();
        } catch {}
      }
    };
    const onAbort = () => {
      killChild();
      finish(() => reject(new Error(`stdio agent ${options.agentId} aborted`)));
    };
    const timeout = setTimeout(() => {
      killChild();
      finish(() => reject(new Error(`stdio agent ${options.agentId} timed out after ${options.timeoutMs}ms`)));
    }, options.timeoutMs);

    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        shell: options.shell ?? false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(() => reject(new Error(`stdio agent ${options.agentId} exited ${code}: ${stderr.trim()}`)));
        return;
      }
      finish(() => resolvePromise(parseStdioOutput(stdout, options.agentId)));
    });

    if (!child.stdin?.writable) {
      finish(() => reject(new Error(`stdio agent ${options.agentId} stdin is not writable`)));
      return;
    }
    child.stdin.end(`${JSON.stringify(options.input)}\n`);
  });
}

function parseStdioOutput(stdout: string, agentId: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error(`stdio agent ${agentId} returned empty stdout`);

  try {
    return extractAgentText(JSON.parse(trimmed), agentId);
  } catch {
    return trimmed;
  }
}

function extractAgentText(data: unknown, agentId: string): string {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") throw new Error(`agent ${agentId} returned unsupported response`);

  const record = data as Record<string, unknown>;
  const text = record.text ?? record.reply ?? record.content ?? record.answer;
  if (typeof text !== "string") {
    throw new Error(
      `agent ${agentId} response must contain text, reply, content, or answer; received keys: ${Object.keys(record).join(", ") || "(none)"}`,
    );
  }
  return text;
}

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();

  if (parent?.aborted) {
    controller.abort();
  } else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) parts.push(current);
  return parts;
}
