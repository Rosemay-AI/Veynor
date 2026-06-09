![Veynor Intro](https://raw.githubusercontent.com/Rosemay-AI/Veynor/main/docs/assets/veynor-intro.png)

---

# Veynor

> **Agent Voice Skill — pluggable voice I/O for any agent runtime**
>
> **Agent 语音技能插件 — 为任意 Agent 运行时提供可插拔的语音 I/O**

You never adapt your agent to Veynor. You install Veynor into your agent.

你不需要改造 Agent 来适配 Veynor。你只需要把 Veynor 装入你的 Agent。

Veynor handles four things / Veynor 处理四件事：

| | English | 中文 |
|---|---|---|
| Audio In | platform PCM → agent callback | 平台音频 → Agent 回调 |
| Audio Out | agent text → TTS → platform audio | Agent 文本 → TTS → 平台音频 |
| Turn Segmentation | silence-based utterance detection | 基于静音的语音断句 |
| Stream Bridge | real-time duplex flow | 实时双向音频流 |

---

## Architecture / 架构

![Architecture](https://raw.githubusercontent.com/Rosemay-AI/Veynor/main/docs/assets/v1.0.0-feature-intro.png)

```text
Agent A + VeynorSkill
Agent B + VeynorSkill
Agent C + VeynorSkill
    ↓ all connect to same voice channel / 全部连接同一个语音频道
Discord / WebRTC handles mixing / 原生音频混音

Per-agent data flow / 每个 Agent 的数据流：
┌──────────────────────────────────┐
│  VeynorSkill (agent's plugin)    │
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

## Quick Start / 快速开始

### Prerequisites / 环境要求

- Node.js ≥ 22
- pnpm
- A Discord Bot Token with voice permissions / 有语音权限的 Discord Bot Token

### Install / 安装

```bash
git clone https://github.com/Rosemay-AI/Veynor.git
cd Veynor
pnpm install
pnpm build
```

### Setup an Agent / 配置 Agent

Each agent has its own Discord bot identity. Shared provider keys (Groq, MiniMax) live in root `.env`. Per-agent Discord tokens live in `agents/<id>/.env`.

每个 Agent 拥有独立的 Discord Bot 身份。共享的 Provider Key 放在根 `.env`，每个 Agent 的 Discord Token 放在 `agents/<id>/.env`。

**Hermes / OpenClaw preset (recommended / 推荐)：**

```bash
veynor agent setup hermes \
  --discord-token <bot-token> \
  --guild <guild-id> \
  --channel "General" \
  --groq-key <groq-key> \
  --minimax-key <minimax-key> \
  --start
```

**Custom HTTP agent / 自定义 HTTP Agent：**

```bash
veynor agent add architect \
  --type http \
  --url http://127.0.0.1:8788/chat \
  --role architect \
  --directory agents/architect \
  --discord-token <bot-token> \
  --guild <guild-id> \
  --channel "General"

veynor agent start architect
```

**Start all registered agents / 启动全部已注册 Agent：**

```bash
veynor agent start --all
```

### Echo Demo / 回音测试 (sanity check)

```bash
cd examples/echo
pnpm start
# In Discord: join a voice channel → speak → hear your voice echoed back
# 在 Discord 中：加入语音频道 → 说话 → 听到自己的回音
```

### Hermes Agent Demo

```bash
cd examples/hermes-demo
pnpm start
# In Discord: join a voice channel → speak → Hermes responds
# 在 Discord 中：加入语音频道 → 说话 → Hermes 回复你
```

### Full STT → LLM → TTS Pipeline / 完整语音管线

```bash
cd examples/agent-demo
pnpm start
# Requires / 需要: GROQ_API_KEY + MINIMAX_API_KEY
```

---

## Packages / 包

| Package / 包 | Description / 说明 | Status |
|---|---|---|
| `@veynor/core` | AudioFrame, VoiceSession, VoiceTurn — frozen runtime primitives / 冻结运行时原语 | ❄ stable |
| `@veynor/skill-sdk` | Skill, SkillPipeline, SkillRuntime — execution layer / 执行层 | stable |
| `@veynor/graph` | Signal DAG, GraphNode, GraphRuntime — advanced composition / 高级编排 | stable |
| `@veynor/agent` | VeynorSkill, RoundtableRuntime, HermesAgent — voice skill plugin / 语音技能插件 | ❄ frozen |
| `@veynor/transport-discord` | Discord voice transport / Discord 语音传输 | stable |
| `@veynor/adapter-openclaw` | OpenClaw Agent Bridge adapter / OpenClaw 适配器 | stable |

---

## CLI Commands / 命令行

```text
init        Initialize .env or scaffold a project    初始化配置或创建项目
doctor      Check Discord, STT, TTS, and backend      检查运行环境
config      Read and write .env values                查看和修改配置
agent       Register local agents                     管理本地 Agent
voice       Manage official, custom, cloned voices    管理音色
meeting     Select roundtable agents                  选择会议 Agent
start       Start Veynor or a demo                    启动运行时或 Demo
```

---

## Creating Your Own Agent / 创建你自己的 Agent

Veynor needs two hooks / Veynor 只需要两个钩子：

```typescript
import { VeynorSkill } from "@veynor/agent";

class MyAgent {
  latestPcm: Buffer | null = null;

  handleAudio(pcm: Buffer) { this.latestPcm = pcm; }

  async *generateResponse(): AsyncIterable<string> {
    // LLM, tools, chain-of-thought — whatever you want / LLM、工具链、思维链 — 随便你
    yield "hello from your agent";
  }
}

const skill = new VeynorSkill({
  id: "my-agent",
  onAudioInput: (pcm) => myAgent.handleAudio(pcm),   // Veynor → agent
  streamText: () => myAgent.generateResponse(),        // agent → Veynor → TTS
});
```

---

## Design Philosophy / 设计理念

> **"Don't define how intelligence works. Define how intelligence gets a voice."**
>
> **"不要定义智能如何工作。定义智能如何获得声音。"**

| Veynor Owns / Veynor 负责 | Agent Owns / Agent 负责 |
|---|---|
| Audio I/O bridge (`onAudioInput` + `streamText`) | Memory, reasoning, tools / 记忆、推理、工具 |
| Turn segmentation (silence detection) | Internal state machine / 内部状态机 |
| Pipeline scheduling | Lifecycle / 生命周期 |
| Transport abstraction | Everything else / 其他一切 |

---

## Docs / 文档

- [Configuration / 配置指南](./docs/configuration.md)
- [Agent Registry CLI / Agent 注册表](./docs/agent-registry-cli.md)
- [Roundtable System / 圆桌系统](./docs/roundtable-system.md)
- [ABI Specification / ABI 规范](./ABI-SPEC.md)

---

## License / 许可

MIT
