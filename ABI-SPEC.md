# Veynor ABI v1.0

This specification is **frozen**. Changes require a new ABI version.

## Principles

1. **Agent owns runtime. Veynor owns voice.** The agent decides when to start, what to say, when to stop. Veynor never calls agent code. Veynor never schedules agent execution.
2. **Turn is the only execution unit.** All voice behavior must be scoped to a turn.
3. **Session only orchestrates turns.** Session holds no content, only schedules.
4. **Runtime is stateless per turn.** LLM/agent runtime does not own session state.

---

## Veynor Core API v1 (frozen ❄)

This is the **only interface an Agent ever sees.** Everything below this line is internal mechanism — hidden from agents.

### Principles

1. **Agent owns runtime. Veynor owns voice.**
   The agent decides when to start, what to say, when to stop. Veynor never calls agent code. Veynor never schedules agent execution.

2. **Veynor never executes agents.**
   No `VeynorAgent`, no `VeynorRuntime` in production. Agent lifecycle is entirely agent-owned.

3. **Agents never manipulate audio.**
   The agent sends text via `speak()`. Audio encoding, transport, PCM, Opus — all hidden inside Veynor implementations.

### Public Surface

Two frozen interfaces. That's it.

```typescript
// What Veynor provides to the platform
interface VeynorVoice {
  start(): Promise<void>;
  stop(): Promise<void>;
  speak(text: string): Promise<void>;
  interrupt(): Promise<void>;
}

// What every Agent implements to get voice
interface VeynorAgent {
  id: string;
  handle(input: string, signal: AbortSignal): AsyncIterable<string>;
}
```

| Interface | Purpose | Who implements |
|-----------|---------|---------------|
| `VeynorVoice` | Platform audio I/O | Veynor (DiscordVoice, etc.) |
| `VeynorAgent` | Text in → text out | Agent author (any framework) |

### VeynorVoice

| Method | Semantics |
|--------|-----------|
| `start()` | Connect to voice platform. Returns when ready to speak and receive audio. Idempotent. |
| `stop()` | Disconnect. Stops all audio I/O. Resolves pending `speak()`. Idempotent. |
| `speak(text)` | Convert text to speech and send to platform. Resolves when playback completes. |
| `interrupt()` | Stop any in-progress `speak()`. Resolves when audio output is fully halted. |

### VeynorAgent

| Field | Semantics |
|-------|-----------|
| `id` | Stable identifier for logging and routing |
| `handle(input, signal)` | Agent receives text, yields text replies. `signal` aborts on interruption. |

`handle()` is the universal entry point. Any agent framework wraps to this:

```typescript
// A LangGraph agent
const agent: VeynorAgent = {
  id: "langgraph-agent",
  async *handle(input, signal) {
    const result = await graph.invoke({ messages: [input] });
    yield result.content;
  }
};

// An Anthropic direct-call agent
const agent: VeynorAgent = {
  id: "claude-agent",
  async *handle(input, signal) {
    const stream = await anthropic.messages.stream({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: input }],
    });
    for await (const event of stream) {
      if (signal.aborted) break;
      if (event.type === "content_block_delta") {
        yield event.delta.text;
      }
    }
  }
};

// A tool-calling agent with multi-step reasoning
const agent: VeynorAgent = {
  id: "code-agent",
  async *handle(input, signal) {
    const plan = await planner.plan(input);
    for (const step of plan.steps) {
      if (signal.aborted) break;
      const result = await toolExecutor.run(step);
      const summary = await summarizer.summarize(result);
      yield summary;
    }
  }
};
```

Agent owns everything inside `handle()`: multi-step reasoning, tool calling, memory, state. Veynor only provides `input: string` and receives `AsyncIterable<string>`. Agent never touches audio.

### Agent Input (internal bridge)

How `input: string` reaches the agent is Veynor-internal and replaceable:

```
audio → silence detection → utterance → STT → text → agent.handle(text, signal)
```

STT is internal. When replaced, agent sees the same `handle(text, signal)` — no interface change.

### Usage (full loop)

```typescript
import { VeynorRuntime, DiscordHost, type VeynorAgent } from "@veynor/agent";
import { DiscordVoiceTransport } from "@veynor/transport-discord";

const agent: VeynorAgent = {
  id: "my-agent",
  async *handle(input, signal) {
    yield `You said: ${input}`;
  },
};

const host = new DiscordHost(new DiscordVoiceTransport({ token, guildId, channelName }));
const runtime = new VeynorRuntime(host, agent);

await runtime.start();
// Agent is live in Discord voice
// Stop with runtime.stop()

### Lifecycle

```
          start()
  [idle] ────────▶ [connected]
                        │
                        │ speak(text)  ← agent decides what to say
                        │ interrupt()  ← agent decides when to stop
                        │
          stop()         │
  [idle] ◀──────── [connected]
```

Agent owns the entire lifecycle. Veynor never transitions state on its own.

### Output

Agent output is `speak(text)`. Veynor handles:
- Text → TTS (internal, replaceable)
- Audio encoding (platform-specific)
- Audio transport (platform-specific)

Agent never sees `AudioFrame`, PCM, or Opus.

### Events (TBD — NOT frozen in v1)

Agent input is NOT frozen. The current implementation passes text via internal mechanisms, but the public API for "agent receives speech" is deliberately deferred.

Options under consideration for v2:

| Option | Shape | Risk |
|--------|-------|------|
| `onTranscript(handler)` | Callback registration | Freezes event model prematurely |
| `onText(handler)` | Callback registration | Too generic |
| `onTurn(handler)` | Turn-scoped event | Binds to turn model |
| EventEmitter | `voice.on("transcript", fn)` | Heavy abstraction |
| AsyncIterator | `for await (const text of voice.transcripts())` | Different mental model |

**Each of these is a one-way door.** The decision affects every agent and every platform adapter. It should be made after at least two real agents (OpenClaw + one other) have been successfully integrated.

### Non-Goals (what Veynor is NOT)

| NOT | Why |
|-----|-----|
| Agent lifecycle management | Agent exists independently. Veynor is a plug-in voice layer. |
| Agent scheduling | Agent is not a task for Veynor to run. |
| Agent memory | Not voice concern. |
| Agent state management | Not voice concern. |
| Multi-agent orchestration | Platform handles audio mixing. Veynor does not coordinate agents. |
| `onTranscript` / `onText` / event system | TBD. Not frozen in v1. |
| `SkillRuntime` as public API | Internal mechanism. Not for agent authors. |

### Platform Adapters

Each platform provides a `VeynorVoice` implementation:

```
interface VeynorVoice
      ↑
      ├── DiscordVoice        (@veynor/transport-discord)
      ├── LiveKitVoice        (@veynor/transport-livekit)
      ├── WebRTCVoice         (@veynor/transport-webrtc)
      └── TencentMeetingVoice (@veynor/transport-tencent-meeting)
```

Internally, each implementation uses layers below (AudioSession, SkillPipeline, AudioTransport) — but agents never see these. Adapters are free to implement event handling internally while the public event API is still TBD.

### Freeze Rules

**Frozen (requires ABI v2 to change):**
- `VeynorVoice` interface — 4 methods, no additions, no removals
- `VeynorAgent` interface — `id: string` + `handle(input, signal)`, no additions
- `start()` semantics — idempotent, returns when ready
- `stop()` semantics — idempotent, stops all I/O, resolves pending speak
- `speak(text)` signature — `string` input, `Promise<void>` output
- `interrupt()` semantics — stops in-progress speak, resolves when halted
- `handle(input, signal)` signature — `string` + `AbortSignal` → `AsyncIterable<string>`
- Agent never imports `Skill`, `SkillPipeline`, `AudioFrame` in production code

**Allowed (no ABI change):**
- New `VeynorVoice` implementations (new platforms)
- Internal STT/TTS engine changes
- Internal pipeline/session architecture changes
- Internal event handling (preparation for v2 event API)

---

## Layer 1 — Audio Frame (immutable data)

```typescript
interface AudioFrame {
  sampleRate: number;   // Hz, e.g. 48000
  channels: number;     // 1 = mono, 2 = stereo
  bitDepth: number;     // 16
  timestamp: number;    // ms, monotonic clock
  speakerId?: string;   // optional, set by transport
  data: Buffer;         // raw PCM samples
}
```

---

## Layer 2 — Voice Session (orchestration)

```typescript
interface VoiceSession {
  start(): Promise<void>;
  close(): Promise<void>;

  pushAudio(frame: AudioFrame): void;
  finishAudio(): void;

  startTurn(): VoiceTurnContext;
  getActiveTurn(): VoiceTurnContext | null;

  interrupt(): void;
}
```

| Method | Semantics |
|--------|-----------|
| `pushAudio` | Routes frame to active turn. Auto-creates turn on first call. |
| `finishAudio` | Signals end of user input for current turn. |
| `startTurn` | Force-starts a new turn (interrupts previous). |
| `interrupt` | Kills current turn. Resets session to idle. |
| `getActiveTurn` | Returns current turn or null. |

**Freeze rule:** No new session-level event APIs. Session must not broadcast audio/transcript globally.

---

## Layer 3 — Voice Turn Context (execution boundary)

```typescript
interface VoiceTurnContext {
  readonly id: string;
  readonly startedAt: number;

  // Output (skill → runtime)
  pushAssistantAudio(frame: AudioFrame): void;
  pushTranscript(text: string): void;

  // Output signal
  closeOutput(): void;

  // Subscriptions (runtime → skill)
  onAudio(cb: (frame: AudioFrame) => void): () => void;
  onTranscript(cb: (text: string) => void): () => void;
  onClose(cb: () => void): () => void;

  // Lifecycle
  abort(): void;
  getAbortSignal(): AbortSignal;
}
```

| Method | Semantics |
|--------|-----------|
| `pushAssistantAudio` | Enqueue TTS frame for this turn. Ignored if turn aborted. |
| `pushTranscript` | Set transcript text, fires listeners. |
| `closeOutput` | Signal TTS stream complete. Fires onClose. |
| `onAudio` | Subscribe to assistant audio output (returns unsubscribe fn). |
| `onTranscript` | Subscribe to transcript updates. |
| `onClose` | Fires when turn completes or aborts. |
| `abort` | Cancel turn. Resets state to idle. Fires onClose. |
| `getAbortSignal` | AbortSignal scoped to this turn's lifecycle. |

**Freeze rule:** All output MUST go through context. No cross-turn state leakage. Context is single execution boundary.

---

## Layer 4 — Voice Processor (pipeline glue)

```typescript
interface VoiceProcessor {
  readonly id: string;
  readonly name: string;

  processUtterance(utterance: Utterance): AsyncIterable<AudioFrame>;
}
```

**Freeze rule:** Processor is glue only. No state ownership. No business logic. No AI model knowledge.

---

## Layer 5 — Runtime Adapter (OpenClaw side)

```typescript
interface OpenClawRuntime {
  createSession(): OpenClawRuntimeSession;
}

interface OpenClawRuntimeSession {
  pushAudio(frame: AudioFrame): void;

  onAudio(cb: (frame: AudioFrame) => void): () => void;
  onTranscript(cb: (text: string) => void): () => void;

  startTurn(): void;
  endTurn(): void;

  interrupt(): void;
  close(): void;
}
```

| Method | Semantics |
|--------|-----------|
| `pushAudio` | Feed user audio to runtime's ASR. |
| `onAudio` | Subscribe to TTS output stream. |
| `onTranscript` | Subscribe to STT transcript. |
| `startTurn` | Signal turn begin (runtime may load context). |
| `endTurn` | Signal user input complete → runtime generates response. |
| `interrupt` | Cancel current generation. |
| `close` | Destroy runtime session, release resources. |

**Freeze rule:** RuntimeSession is per-turn. MUST NOT leak cross-turn state. MUST NOT assume session-level memory.

---

## Boundary Diagram

```
┌─────────────────────────────────────────────┐
│              Agent — implements VeynorAgent │
│  (LangGraph / AutoGen / Claude / custom)     │
│                                             │
│  const agent: VeynorAgent = {              │
│    id: "my-agent",                          │
│    handle: async function* (input, signal) {│
│      yield await myReasoning.run(input)     │
│    }                                        │
│  }                                          │
└──────────────────┬──────────────────────────┘
                   │ implements
                   ▼
┌──────────────────────────────────────────────┐
│      Veynor Core API v1 (frozen ❄)          │
│  interface VeynorAgent { handle() }         │
│  interface VeynorVoice { start/stop/speak } │
└──────────────────┬───────────────────────────┘
                   │ bridged by
                   ▼
┌──────────────────────────────────────────────┐
│         VeynorRuntime (internal bridge)      │
│  silence detection → STT → agent.handle()    │
│  → TTS → audio output                        │
└──────────────────┬───────────────────────────┘
                   │ uses
                   ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ Discord  │ │ LiveKit  │ │ WebRTC   │
│ Voice    │ │ Voice    │ │ Voice    │
└──────────┘ └──────────┘ └──────────┘
```

---

## Layer 6 — Skill Composition (SDK layer, non-core)

Composition lives in `@veynor/skill-sdk` and does NOT modify core ABI.
It builds on top of the frozen `Skill` / `SkillContext` interface.

```typescript
interface PipelineContext extends SkillContext {
  readonly transcript: string;
}

interface SkillStep {
  readonly id: string;
  readonly skill: Skill;
  readonly name?: string;
}

class SkillPipeline extends Skill {
  readonly id: string;
  readonly name: string;
  readonly steps: SkillStep[];

  execute(utterance: SkillUtterance, ctx: SkillContext): AsyncIterable<AudioFrame>;
}
```

### Pipeline Data Flow

```
utterance.audio()
       │
       ▼
  ┌─────────┐    audio frames    ┌─────────┐    audio frames    ┌─────────┐
  │ Step 1  │ ────────────────▶ │ Step 2  │ ────────────────▶ │ Step 3  │
  │ (STT)   │                    │ (LLM)   │                    │ (TTS)   │
  └────┬────┘                    └────┬────┘                    └────┬────┘
       │ ctx.say(text)                │ ctx.say(reply)                │
       ▼                              ▼                              ▼
  transcript="text"             transcript="reply"             yield audio
```

| Rule | Behavior |
|------|----------|
| `say()` interception | Pipeline captures `say()` output as `transcript`, forwards to outer context |
| `transcript` access | Each step reads the PREVIOUS step's `say()` output via `ctx.transcript` |
| Audio routing | Step N's audio output becomes Step N+1's audio input |
| Final output | Only the LAST step's audio frames are yielded |
| Abort propagation | `ctx.abortSignal` is shared across all steps |

### Factory API

```typescript
// Quick pipeline: ordered array of Skills
pipe([sttSkill, llmSkill, ttsSkill])

// Named pipeline with explicit step config
compose("my-pipeline", [
  step(sttSkill),
  step(llmSkill, { name: "planner" }),
  step(ttsSkill),
])
```

**Key property:** `SkillPipeline extends Skill` — it IS a Skill, so it works transparently
with `registerSkill()`, `SkillAdapter`, and `SkillRuntime` without any changes.

### Allowed Composition Patterns (no ABI change)

- Linear `pipe([s1, s2, s3])` — ordered execution
- Named `compose(id, [step(s1), step(s2)])` — explicit step config
- Nested pipelines: `pipe([pipe([a, b]), c])` — hierarchical composition
- Runtime switching: `runtime.switchTo("pipeline-stt-llm-tts")` — hot swap to composition

---

## Layer 7 — Signal Graph (graph layer, non-core)

Graph lives in `@veynor/graph` and does NOT modify core ABI.
It builds on top of `Skill` / `SkillContext` from `@veynor/skill-sdk`.

### Signal (typed data carrier)

`Signal` is the universal data carrier that flows through graph edges.
Unlike Pipeline's implicit `transcript`, graph nodes route typed signals explicitly.

```typescript
type SignalType = "audio" | "text" | "intent" | "tool_call" | "tool_result" | "memory" | "control";

interface Signal<T extends string = SignalType, P = unknown> {
  readonly type: T;
  readonly id: string;          // unique signal id
  readonly sourceNodeId: string;
  readonly timestamp: number;
  readonly payload: P;
}
```

| Signal | Payload |
|--------|---------|
| `audio` | `AsyncIterable<AudioFrame> \| AudioFrame[]` |
| `text` | `string` |
| `intent` | `{ name, params }` |
| `tool_call` | `{ tool, arguments }` |
| `tool_result` | `{ tool, result }` |
| `memory` | `{ context, source? }` |
| `control` | `{ command: "abort"\|"pause"\|"resume"\|"route", target? }` |

**Freeze rule:** `SignalType` union is extensible (add new types), but existing types MUST NOT change payload shape.

### Port (typed interface)

Each node exposes typed input/output ports. Ports declare which `SignalType`s they accept.

```typescript
interface Port {
  readonly id: string;
  readonly direction: "input" | "output";
  readonly accepts: SignalType[];
  readonly required: boolean;
  readonly name?: string;
}
```

### Edge (typed connection)

Edges connect ports with optional transformation and conditional routing.

```typescript
type EdgeTransform = (signal: Signal) => Signal | Signal[] | null;
type EdgeCondition = (signal: Signal) => boolean;

interface Edge {
  readonly id: string;
  readonly from: { nodeId: string; portId: string };
  readonly to: { nodeId: string; portId: string };
  readonly transform?: EdgeTransform;
  readonly condition?: EdgeCondition;
}
```

| Transform return | Semantics |
|-----------------|-----------|
| `Signal` | Pass-through or modified signal |
| `Signal[]` | Fan-out — split one signal into many |
| `null` | Filter — drop signal on this edge |

### Node Contract (GraphNode)

`GraphNode extends Skill` — it IS a Skill, so it works transparently with
`registerSkill()`, `SkillAdapter`, `SkillRuntime`, and `SkillPipeline`.

```typescript
abstract class GraphNode extends Skill {
  abstract readonly ports: { inputs: Port[]; outputs: Port[] };

  abstract executeSignals(
    inputs: Signal[],
    ctx: SkillContext
  ): AsyncIterable<Signal>;

  // bridge: AudioFrame execute() → Signal executeSignals()
  execute(utterance: SkillUtterance, ctx: SkillContext): AsyncIterable<AudioFrame>;
}
```

| Method | Semantics |
|--------|-----------|
| `executeSignals` | Multi-signal I/O — the graph-native execution entry |
| `execute` (inherited bridge) | Wraps utterance audio as AudioSignal → calls `executeSignals` → extracts AudioFrame outputs |

**Key property:** `GraphNode` can be used anywhere `Skill` is expected. The built-in
`execute()` bridge auto-converts audio ↔ signal.

### SkillBridge (compatibility)

Wraps any legacy `Skill` as a `GraphNode` with `audio_in` / `audio_out` ports.
This allows mixing old Skills and new GraphNodes in the same graph.

```typescript
class SkillBridge extends GraphNode {
  constructor(skill: Skill);
  // ports: { inputs: [audio_in], outputs: [audio_out] }
  executeSignals(inputs, ctx): AsyncIterable<Signal>;
}
```

### Graph Data Flow (example)

```
  ┌──────────┐  audio  ┌──────────┐  text+intent  ┌──────────┐  audio  ┌──────────┐
  │  STT     │────────▶│   LLM    │─────────────▶ │  TTS     │────────▶│  audio   │
  │  Node    │         │  Node    │               │  Node    │         │  out     │
  └──────────┘         └────┬─────┘               └──────────┘         └──────────┘
                            │ intent
                            ▼
                      ┌──────────┐
                      │  Router  │
                      │  Node    │
                      └────┬─────┘
                           │ tool_call
                           ▼
                      ┌──────────┐  tool_result
                      │  Tool    │────────────▶ ...back to LLM
                      │  Node    │
                      └──────────┘
```

### Factory API

```typescript
// Signals
audioSignal(nodeId, audioFrames)
textSignal(nodeId, "hello")
intentSignal(nodeId, "search", { query: "..." })
toolCallSignal(nodeId, "calculator", { expression: "1+1" })

// Ports
inputPort("audio_in", ["audio"])
outputPort("text_out", ["text"])

// Edges
edge("e1", "stt", "text_out", "llm", "text_in")
edge("e2", "llm", "audio_out", "tts", "audio_in",
  { condition: s => isAudio(s) })

// Bridge
new SkillBridge(legacySkill)
```

### Allowed Graph Patterns (no ABI change)

- New `GraphNode` implementations with custom ports and `executeSignals()`
- New `SignalType` values (e.g. `"emotion"`, `"translation"`)
- Mixing legacy `Skill` nodes (via `SkillBridge`) with native `GraphNode`s
- Nested graphs: a `GraphNode` that internally hosts a sub-graph
- Edge transforms and conditions for routing/filtering/fan-out

---

## Layer 8 — Graph Runtime (execution engine, non-core)

Runtime lives in `@veynor/graph` and implements push-model DAG execution on top of the Signal Graph ABI.

### Execution Model

**Push-model with barrier activation.** Signals flow through edges from node outputs to downstream node inputs. A node activates when ALL required input ports have received signals.

```
Signal arrives → route via edges → buffer at target ports
                                    ↓
                          all required ports ready?
                                    ↓ yes
                          activate node → executeSignals()
                                    ↓
                          output signals → back to routing
```

### Causality Model

| Rule | Semantics |
|------|-----------|
| Signal ordering | Per-port: FIFO. Cross-port: activation fires only when all required ports are satisfied |
| Fan-out determinism | Edge transforms produce ordered Signal[], guaranteed sequential delivery |
| Merge barrier | Node with N required inputs waits for ALL N ports to receive ≥1 signal before activation |
| Drop/abort | `ctx.abortSignal.aborted` stops the main loop. Control signals with `"abort"` command set execCtx.isAborted |

### GraphRuntime (extends Skill)

### GraphRuntime (single-class DAG executor)

`GraphRuntime extends Skill` — it IS a Skill, so it works transparently with
`registerSkill()`, `SkillAdapter`, `SkillRuntime`, and `SkillPipeline`.

```typescript
class GraphRuntime extends Skill {
  readonly id: string;
  readonly name: string;
  readonly nodes: Map<string, GraphNode>;
  readonly edges: Edge[];

  // Skill interface: voice utterance → DAG → AudioFrame output
  execute(utterance: SkillUtterance, ctx: SkillContext): AsyncIterable<AudioFrame>;

  // Graph-native: Signal → DAG → Signal output  
  run(input: Signal, ctx: SkillContext): AsyncIterable<Signal>;
}
```

| Method | Semantics |
|--------|-----------|
| `execute` | Wraps utterance audio as AudioSignal → calls `run()` → extracts AudioFrame outputs |
| `run` | Seeds input to entry nodes → push-loop over scheduler → yields terminal signals |

### Execution Flow

```
1. Seed input signal → entry nodes (nodes with no incoming edges)
2. Main loop:
   a. Dequeue signal from scheduler
   b. Route via matching edges → buffer at target port, enqueue routed signals
   c. No edges matched → yield as terminal output
   d. For each target node: if ALL required ports have signals → collect inputs → clear buffers → executeSignals()
   e. Output signals from activation → enqueue in scheduler → loop back to (a)
3. Loop terminates when:
   - Scheduler queue is empty (no more signals to process)
   - ctx.abortSignal.aborted
   - maxActivations limit reached
   - maxQueueDepth limit exceeded
```

### Entry / Terminal Semantics

| Node type | Behavior |
|-----------|----------|
| Entry node | No incoming edges. Seeded with input signal on first matching port |
| Terminal node | No outgoing edges. Its output signals are yielded from `run()` |
| Intermediate node | Has both incoming and outgoing edges. Normal activation flow |

### Safety Limits

```typescript
type GraphRuntimeOptions = {
  maxActivations?: number;  // default: 1000 — prevents infinite loops
  maxQueueDepth?: number;   // default: 10000 — prevents unbounded growth
};
```

### Integration

```typescript
// Register a graph as a Skill in the existing infrastructure
const graph = new GraphRuntime("voice-agent", [sttNode, llmNode, ttsNode], [
  edge("e1", "stt", "text_out", "llm", "text_in"),
  edge("e2", "llm", "audio_out", "tts", "audio_in"),
]);

registerSkill(graph);                    // works with SkillRegistry
const adapter = new SkillAdapter(graph); // works with SkillAdapter
runtime.switchTo("voice-agent");         // works with SkillRuntime
pipe([graph, postProcessSkill]);         // works with SkillPipeline
```

### Allowed Graph Runtime Patterns (no ABI change)

- New scheduling strategies (topological, priority, parallel)
- Per-node execution timeouts
- Graph visualization / debugging tools
- Backpressure control mechanisms
- Multi-graph orchestration (one graph calls another via `GraphRuntime` node)

---

## Layer 9 — VeynorRuntime + Demo (internal, NOT frozen)

### VeynorRuntime

`VeynorRuntime` is the internal bridge that wires `VeynorHost` ↔ `VeynorAgent`. It handles:

```
host.input() → silence detection → STT → agent.handle() → TTS → host.output()
```

```typescript
class VeynorRuntime {
  constructor(host: VeynorHost, agent: VeynorAgent);
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Agent authors never construct `VeynorRuntime` directly — they use the platform adapter's built-in wiring. The runtime exists as a reusable internal component shared by all `VeynorVoice` implementations.

### Demo artifacts (reference only)

- `HermesAgent` — convenience wrapper used by demo tests
- `VeynorSkill` + `createVeynorSkill` — internal Skill-based bridge, used by wire/integration/stability tests
- `SkillPipeline` — internal linear composition mechanism

These exist for **verification of internal mechanisms only.** Production agents should NOT import or depend on them.

---

## Freeze Rules

**Prohibited (requires ABI v2):**

Core API:
- Changing `VeynorVoice` interface shape (4 methods: start, stop, speak, interrupt)
- Changing `VeynorAgent` interface shape (id + handle(input, signal))
- Adding events or callbacks to either frozen interface
- Changing `speak(text)` signature or return semantics
- Changing `handle(input, signal)` signature or return semantics
- Adding state queries to `VeynorVoice`
- Requiring agents to import `Skill`, `SkillPipeline`, or `AudioFrame`

Internal:
- Adding session-level event/broadcast APIs
- Bypassing `VoiceTurnContext` for audio/transcript routing
- Runtime direct access to session state
- Processor becoming business logic layer
- `AudioFrame.data` changing type

**Allowed (no ABI change):**

Core API:
- New `VeynorVoice` implementations (new platforms: Discord, LiveKit, WebRTC, Tencent Meeting)
- Internal STT/TTS engine changes (agent sees same `onTranscript` / `speak`)
- Internal pipeline architecture changes

Internal:
- New Skill implementations
- New Transport implementations
- New `VoiceProcessor` implementations
- Internal state machine refinements within `BaseVoiceSession` / `BaseVoiceTurn`
- New `SignalType` values (backward compatible extension)
- New `GraphNode` implementations
- New `EdgeTransform` / `EdgeCondition` functions
- Mixing legacy `Skill` and native `GraphNode` in the same graph
- Nested graphs
- Graph runtime implementations
- Agent-internal memory systems — agent-owned
- Agent-internal tool systems — agent-owned
