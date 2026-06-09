import type { AudioFrame } from "@veynor/core";

let _nextSignalId = 0;
function nextId(): string {
  return `sig-${++_nextSignalId}`;
}

export type SignalType =
  | "audio"
  | "text"
  | "intent"
  | "tool_call"
  | "tool_result"
  | "memory"
  | "control";

export interface Signal<T extends string = SignalType, P = unknown> {
  readonly type: T;
  readonly id: string;
  readonly sourceNodeId: string;
  readonly timestamp: number;
  readonly payload: P;
}

export type AudioSignal = Signal<
  "audio",
  AsyncIterable<AudioFrame> | AudioFrame[]
>;
export type TextSignal = Signal<"text", string>;
export type IntentSignal = Signal<
  "intent",
  { name: string; params: Record<string, unknown> }
>;
export type ToolCallSignal = Signal<
  "tool_call",
  { tool: string; arguments: Record<string, unknown> }
>;
export type ToolResultSignal = Signal<
  "tool_result",
  { tool: string; result: unknown }
>;
export type MemorySignal = Signal<"memory", { context: string; source?: string }>;
export type ControlSignal = Signal<
  "control",
  { command: "abort" | "pause" | "resume" | "route"; target?: string }
>;

export function createSignal<T extends string, P>(
  type: T,
  sourceNodeId: string,
  payload: P
): Signal<T, P> {
  return {
    type,
    id: nextId(),
    sourceNodeId,
    timestamp: Date.now(),
    payload,
  };
}

export function audioSignal(
  sourceNodeId: string,
  audio: AsyncIterable<AudioFrame> | AudioFrame[]
): AudioSignal {
  return createSignal("audio", sourceNodeId, audio);
}

export function textSignal(sourceNodeId: string, text: string): TextSignal {
  return createSignal("text", sourceNodeId, text);
}

export function intentSignal(
  sourceNodeId: string,
  name: string,
  params: Record<string, unknown> = {}
): IntentSignal {
  return createSignal("intent", sourceNodeId, { name, params });
}

export function toolCallSignal(
  sourceNodeId: string,
  tool: string,
  args: Record<string, unknown> = {}
): ToolCallSignal {
  return createSignal("tool_call", sourceNodeId, { tool, arguments: args });
}

export function toolResultSignal(
  sourceNodeId: string,
  tool: string,
  result: unknown
): ToolResultSignal {
  return createSignal("tool_result", sourceNodeId, { tool, result });
}

export function memorySignal(
  sourceNodeId: string,
  context: string,
  source?: string
): MemorySignal {
  return createSignal("memory", sourceNodeId, { context, source });
}

export function controlSignal(
  sourceNodeId: string,
  command: ControlSignal["payload"]["command"],
  target?: string
): ControlSignal {
  return createSignal("control", sourceNodeId, { command, target });
}

export function isAudio(s: Signal): s is AudioSignal {
  return s.type === "audio";
}

export function isText(s: Signal): s is TextSignal {
  return s.type === "text";
}

export function isIntent(s: Signal): s is IntentSignal {
  return s.type === "intent";
}

export function isToolCall(s: Signal): s is ToolCallSignal {
  return s.type === "tool_call";
}

export function isToolResult(s: Signal): s is ToolResultSignal {
  return s.type === "tool_result";
}
