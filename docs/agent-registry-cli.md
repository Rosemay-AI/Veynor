# Veynor Agent Registry CLI

Veynor should run as one local host process. Agents register into that host; they do not each install or run their own Veynor runtime.

```text
One Veynor Host
  -> Agent Registry
  -> Roundtable Runtime
  -> Voice Transport
```

## Register Agents

HTTP agent:

```bash
veynor agent add architect --type http --url http://127.0.0.1:8788/chat --role architect --domains architecture,runtime --voice architect-voice
```

stdio agent:

```bash
veynor agent add critic --type stdio --cmd "node examples/agents/critic-agent.js" --role critic --domains risk,review --voice critic-voice
```

local module agent:

```bash
veynor agent add planner --type module --module ./examples/agents/planner-agent.js --role planner --domains planning,implementation --voice planner-voice
```

## Inspect Registry

```bash
veynor agent list
veynor agent show architect
veynor agent export
veynor agent remove architect
```

By default, Veynor writes local agent registration to:

```text
.veynor/agents.json
```

This path is ignored by git because it can contain local URLs, command paths, and machine-specific voice settings.

Use `--registry <path>` when a project needs a different registry file.

## Registry Shape

```json
{
  "version": 1,
  "agents": [
    {
      "id": "architect",
      "type": "http",
      "role": "architect",
      "domains": ["architecture", "runtime"],
      "voiceId": "architect-voice",
      "transport": {
        "url": "http://127.0.0.1:8788/chat"
      }
    }
  ]
}
```

The next runtime layer can load this registry and convert entries into `RoundtableAgent` adapters.

## Declarative Floor Requests

Registry agents can declare simple rule-based follow-up requests:

```json
{
  "id": "critic",
  "type": "module",
  "role": "critic",
  "domains": ["risk"],
  "floorRequests": [
    {
      "round": 1,
      "intent": "challenge",
      "reason": "Challenge unresolved runtime risk after the initial speakers.",
      "priority": 90
    }
  ],
  "transport": {
    "module": "./examples/agents/critic-agent.js"
  }
}
```

Supported match fields:

- `round`
- `afterAgentId`
- `afterIntent`
- `whenTranscriptIncludes`

The runtime still sends matching requests through the Arbiter before the agent receives another floor token.

## Select Agents For A Meeting

The registry is the full local agent roster. A meeting selection is the subset that enters the current roundtable.

```bash
veynor meeting agents
veynor meeting select architect critic planner
veynor meeting status
veynor meeting prepare --agents architect,critic,planner
veynor meeting clear
```

This writes:

```text
.veynor/meeting.json
```

You can also select agents at startup:

```bash
veynor start --agents architect,critic,planner
```

The intended runtime flow is:

```text
veynor start --agents architect,critic,planner
  -> load .veynor/agents.json
  -> save .veynor/meeting.json
  -> start Veynor Host
  -> pass selected agent IDs into RoundtableRuntime.runTurn({ agentIds })
```

Users choose who enters the voice meeting; Veynor remains the single host and scheduler.

## Voice Profiles / 音色配置

Voices are managed separately from agents so users can reuse one voice across multiple agents, switch providers, or register cloned voices without editing JSON by hand.

音色配置和 agent 分开管理。这样中文用户可以先维护一个音色库，再把音色绑定到不同 agent 上，不需要手动编辑 JSON。

Voice profiles are stored in:

```text
.veynor/voices.json
```

Register an official MiniMax voice / 登记官方音色:

```bash
veynor voice official assistant --provider minimax --providerVoiceId female-shaonv --model speech-2.8-hd --zh-name "中文女声" --zh-description "温柔清晰，适合默认助手"
```

Register a custom provider voice id / 登记自定义音色:

```bash
veynor voice custom narrator --provider minimax --providerVoiceId your_custom_voice_id --zh-name "旁白" --zh-description "稳定、清楚，适合长文本朗读"
```

Register a cloned voice after preparing source audio. The CLI records the clone workflow metadata and requires explicit consent.

克隆音色需要明确授权。CLI 会记录源音频、服务商返回的音色 ID、中文备注等信息，方便团队后续排查来源和用途。

```bash
veynor voice clone host-clone --source ./samples/host.wav --consent true --providerVoiceId cloned_voice_id --zh-name "主持人克隆音" --comment "仅用于项目演示，已获得授权"
```

Assign a voice to an agent / 绑定音色到 agent:

```bash
veynor voice use architect assistant
```

This writes the provider `voiceId` and optional TTS settings into `.veynor/agents.json`, where `VeynorSkill` already reads per-agent voice settings.

音色字段说明:

| Field | 中文说明 |
| --- | --- |
| `id` | 本地音色 ID，用于 `veynor voice use` |
| `providerVoiceId` | MiniMax 等服务商的真实音色 ID |
| `zhName` | 中文名称，展示给中文用户 |
| `zhDescription` | 中文说明，例如声音风格和适用场景 |
| `comment` | 备注，例如来源、授权状态、用途 |
| `model` | TTS 模型，默认推荐 `speech-2.8-hd` |

## Host Integration

`@veynor/agent` can load the local registry and current meeting selection:

```ts
import { VeynorSkill } from "@veynor/agent";

const veynor = await VeynorSkill.create(defaultAgent, {
  groqApiKey,
  minimaxApiKey,
  roundtable: {
    localRegistry: {
      cwd: process.cwd(),
      registryPath: ".veynor/agents.json",
      meetingPath: ".veynor/meeting.json",
    },
    objective: (text) => ({
      kind: "review_plan",
      prompt: text,
      requiredOutput: "A project feasibility review and implementation plan.",
    }),
  },
});
```

This creates one Veynor host with only the selected meeting agents loaded into its `RoundtableRuntime`.
