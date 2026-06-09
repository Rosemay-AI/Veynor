# Veynor

> **Agent Voice Skill — pluggable voice I/O for any agent runtime**
>
> Veynor is not where agents meet. Veynor is how each agent learns to speak and listen.

---

## What is Veynor?

Veynor is a **per-agent voice skill plugin**. Each agent installs its own Veynor instance. The platform (Discord, WebRTC, etc.) handles audio mixing naturally.

You never adapt your agent to Veynor. You install Veynor into your agent.

Veynor handles four things:

- **Audio In** — platform PCM → agent callback
- **Audio Out** — agent text → TTS → platform audio
- **Turn Segmentation** — silence-based utterance detection
- **Stream Bridge** — real-time duplex flow

Your agent only needs two hooks:

```typescript
const skill = new VeynorSkill({
  id: "my-agent",
  onAudioInput: (pcm) => myAgent.handleAudio(pcm),    // Veynor → agent
  streamText: () => myAgent.generateResponse(),         // agent → Veynor → TTS
});
```

---

## Architecture

```
Agent A + VeynorSkill
Agent B + VeynorSkill
Agent C + VeynorSkill
    ↓ all connect to same voice channel
Discord / WebRTC handles mixing

Per-agent data flow:
┌──────────────────────────────────┐
│  VeynorSkill (agent's plugin)   │
│  onAudioInput(pcm) → agent       │
│  streamText() ← agent            │
│  ctx.say(text) → Pipeline → TTS  │
└────────────┬─────────────────────┘
             │ extends Skill
             ↓
┌──────────────────────────────────┐
│  Skill Runtime                   │
│  SkillPipeline / Graph           │
└────────────┬─────────────────────┘
             │ VoiceTurnContext
             ↓
┌──────────────────────────────────┐
│  Core Runtime (frozen ABI)       │
│  AudioFrame / VoiceSession       │
└────────────┬─────────────────────┘
             │ PCM streaming
             ↓
┌──────────────────────────────────┐
│  Discord / WebRTC Transport      │
└──────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- Node.js ≥ 22
- pnpm
- A Discord Bot Token with voice permissions

### Install

```bash
git clone <repo-url> veynor
cd veynor
pnpm install
pnpm build
```

### Configure

```bash
cp .env.example .env
# Edit .env with the keys required for the demo you run.
```

See [docs/configuration.md](./docs/configuration.md) for the full key list and cost tiers. The echo demo only needs Discord configuration; the recommended full voice-agent path uses MiniMax for LLM + TTS and adds Groq only for STT.

### Run: Echo Demo (sanity check)

```bash
cd examples/echo
pnpm start
```

In Discord: join a voice channel → speak → hear your voice echoed back.

### Run: Hermes Agent Demo

```bash
cd examples/hermes-demo
pnpm start
```

In Discord: join a voice channel → speak → Hermes responds.

To use a real LLM, replace the `processText` function:

```typescript
const hermes = new HermesAgent({
  processText: async (text, history) => {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "You are Hermes, a concise voice assistant." }, { role: "user", content: text }],
      }),
    });
    return { text: (await response.json()).choices[0].message.content };
  },
});
const skill = new VeynorSkill(hermes.toSkillOptions());
```

---

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| `@veynor/core` | AudioFrame, VoiceSession, VoiceTurn — frozen runtime primitives | ❄ stable |
| `@veynor/skill-sdk` | Skill, SkillPipeline, SkillRuntime — execution layer | stable |
| `@veynor/graph` | Signal DAG, GraphNode, GraphRuntime — advanced composition | stable |
| `@veynor/agent` | VeynorSkill, VeynorSkillOptions, HermesAgent — voice skill plugin | ❄ frozen |
| `@veynor/transport-discord` | Discord voice transport | stable |
| `@veynor/adapter-openclaw` | OpenClaw Agent Bridge adapter | stable |

---

## Creating Your Own Agent

```typescript
import { VeynorSkill } from "@veynor/agent";

// Your agent — any existing codebase, any architecture
class MyAgent {
  latestPcm: Buffer | null = null;

  handleAudio(pcm: Buffer) { this.latestPcm = pcm; }

  async *generateResponse(): AsyncIterable<string> {
    if (!this.latestPcm) return;
    const text = await this.think(this.latestPcm);
    yield text;
  }

  async think(pcm: Buffer): Promise<string> {
    // LLM, tools, chain-of-thought — whatever you want
    return "I received " + pcm.length + " bytes of audio";
  }
}

const myAgent = new MyAgent();

// Install Veynor — no interface to implement, no contract
const voiceSkill = new VeynorSkill({
  id: "my-agent",
  onAudioInput: (pcm) => myAgent.handleAudio(pcm),
  streamText: () => myAgent.generateResponse(),
});

registerSkill(voiceSkill);
pipe([voiceSkill, ttsSkill]);
```

### Direct callbacks (no class wrapper needed)

```typescript
const skill = new VeynorSkill({
  id: "direct",
  onAudioInput: (pcm) => console.log("got", pcm.length, "bytes"),
  streamText: async function* () { yield "hello world"; },
});
```

---

## Design Philosophy

> **"Don't define how intelligence works. Define how intelligence gets a voice."**

| Veynor Owns | Agent Owns |
|-------------|-----------|
| Audio I/O bridge (`onAudioInput` + `streamText`) | Memory, reasoning, tools |
| Turn segmentation (silence detection) | Internal state machine |
| Pipeline scheduling | Lifecycle |
| Transport abstraction | Everything else |

---

## Examples

| Example | Description | External Dependencies |
|---------|-------------|----------------------|
| `echo` | Voice loopback — verify Discord PCM link | None |
| `hermes-demo` | VeynorSkill + HermesAgent + TTS | None |
| `agent-demo` | Full STT → LLM → TTS pipeline | Groq + MiniMax API keys |
| `openclaw-demo` | OpenClaw Agent Bridge integration | OpenClaw runtime |

---

## Commands

```bash
pnpm install          # install dependencies
pnpm build            # build all packages
pnpm typecheck        # type-check all packages + examples
```

---

## ABI Specification

See [ABI-SPEC.md](./ABI-SPEC.md) for the frozen 9-layer architecture specification.

---

## License

MIT
