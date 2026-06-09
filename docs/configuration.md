# Veynor Configuration

Veynor can be run in several cost tiers. Users do not need every API key for every demo.

The recommended low-cost production path is:

```text
Discord voice transport
  + Groq STT only when speech input is needed
  + MiniMax for both LLM replies and TTS playback
```

MiniMax currently covers the LLM and text-to-speech parts of this stack. The public MiniMax API docs do not list a stable speech-to-text endpoint, so Veynor keeps STT as a separate optional provider for now.

## Configuration Layout

Veynor v0.2 separates shared provider keys from per-agent Discord identity:

```text
F:\VoiceSkill\
  .env
    GROQ_API_KEY
    MINIMAX_API_KEY
    LLM_URL / LLM_API_KEY / LLM_MODEL
  .veynor/
    agents.json
  agents/
    <agent-id>/
      .env
        DISCORD_BOT_TOKEN
        GUILD_ID
        VOICE_CHANNEL_NAME
```

Root `.env` is shared by all agents. Each `agents/<agent-id>/.env` belongs to one Discord bot identity, so multiple agents can join the same voice channel with separate bot tokens.

For Hermes/OpenClaw, use the one-command setup preset. It writes root provider keys, creates `agents/hermes/.env`, generates the Hermes adapter, registers `.veynor/agents.json`, and can start immediately:

```powershell
veynor agent setup hermes `
  --discord-token <bot-token> `
  --guild <guild-id> `
  --channel "General" `
  --openclaw-mjs "D:\npm-global\node_modules\openclaw\openclaw.mjs" `
  --groq-key <groq-key> `
  --minimax-key <minimax-key> `
  --start
```

Without `--start`, run `veynor agent start hermes` after checking the merged config:

```powershell
veynor agent env hermes
veynor agent start hermes
```

For custom HTTP/module/stdio agents, create an agent directory with:

```bash
veynor agent add architect \
  --type http \
  --url http://127.0.0.1:8788/chat \
  --role architect \
  --directory agents/architect \
  --discord-token <bot-token> \
  --guild <guild-id> \
  --channel "General"
```

Then inspect merged config with:

```bash
veynor agent env architect
```

## Required Keys By Use Case

| Use case | Required keys | Paid model calls |
| --- | --- | --- |
| Echo / Discord sanity check | Agent `.env`: `DISCORD_BOT_TOKEN`, `GUILD_ID`, `VOICE_CHANNEL_NAME` | None |
| Text-only MiniMax agent | Root `.env`: `MINIMAX_API_KEY`; Agent `.env`: Discord keys | MiniMax LLM |
| Listen-only STT | Root `.env`: `GROQ_API_KEY`; Agent `.env`: Discord keys | Groq Whisper STT |
| Speak-only TTS | Root `.env`: `MINIMAX_API_KEY`; Agent `.env`: Discord keys | MiniMax TTS |
| Recommended full voice agent | Root `.env`: `GROQ_API_KEY`, `MINIMAX_API_KEY`; Agent `.env`: Discord keys | Groq STT + MiniMax LLM/TTS |
| Custom LLM backend | Root `.env`: STT/TTS keys + LLM backend; Agent `.env`: Discord keys | STT + custom LLM + TTS |
| OpenClaw agent backend | Root `.env`: `OPENCLAW_MJS` or `OPENCLAW_URL`; Agent `.env`: Discord keys | Depends on the OpenClaw agent |

## Environment Variables

### Per-Agent Discord

| Variable | Required | Used for |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Yes for each Discord agent | Bot login and voice connection |
| `GUILD_ID` | Yes for each Discord agent | Discord server selection |
| `VOICE_CHANNEL_NAME` | Yes for each Discord agent | Voice channel lookup |

These variables live in `agents/<agent-id>/.env`, not the root `.env`.

### Agent / LLM Backend

| Variable | Required | Used for |
| --- | --- | --- |
| `OPENCLAW_MJS` | Optional | Local OpenClaw CLI subprocess |
| `OPENCLAW_URL` | Optional | OpenClaw or compatible HTTP agent service |
| `LLM_URL` | Optional | OpenAI-compatible LLM endpoint for generated project config |
| `LLM_API_KEY` | Optional | Bearer token for `LLM_URL` when required |
| `LLM_MODEL` | Optional | Model name for `LLM_URL` |

Use either a local/mock agent, `OPENCLAW_MJS`, `OPENCLAW_URL`, or an LLM endpoint depending on the integration. Echo mode does not need any LLM key.

For the default low-cost path, use MiniMax for agent responses instead of configuring a separate `LLM_API_KEY`. In that mode, `MINIMAX_API_KEY` is the shared key for both LLM and TTS.

### Speech Providers

| Variable | Required | Default | Used for |
| --- | --- | --- | --- |
| `GROQ_API_KEY` | Optional | none | Groq Whisper speech-to-text |
| `GROQ_STT_MODEL` | Optional | `whisper-large-v3` | STT model |
| `GROQ_STT_LANGUAGE` | Optional | `zh` | STT language hint |
| `MINIMAX_API_KEY` | Optional | none | MiniMax LLM and text-to-speech |
| `MINIMAX_MODEL` | Optional | `speech-2.8-hd` | TTS model. Recommended for Token Plan users. |
| `MINIMAX_LLM_MODEL` | Optional | `MiniMax-M3` | LLM model when MiniMax drives the agent reply |

## Getting A Free Groq STT Key

Groq is used only for speech-to-text in the recommended setup. MiniMax still handles LLM replies and TTS playback.

1. Go to the Groq Console: https://console.groq.com
2. Sign in or create a free account.
3. Open the API Keys page: https://console.groq.com/keys
4. Click `Create API Key`.
5. Copy the generated key. Groq keys usually start with `gsk_`.
6. Paste it into `.env`:

```env
GROQ_API_KEY=gsk_your_key_here
GROQ_STT_MODEL=whisper-large-v3
GROQ_STT_LANGUAGE=zh
```

Groq's free tier does not require a credit card for getting started, but it is rate-limited. If transcription stops with quota or rate-limit errors, wait for the quota reset or switch to a paid Groq tier. Check the current account limits in Groq Console because free-tier limits can change.

## Cost Guidance

Keep the default onboarding path cheap:

- Start with `examples/echo`: only Discord is required.
- Add STT only when the bot must understand spoken input.
- Add MiniMax only when the bot must generate or speak replies.
- Add a custom LLM backend only when MiniMax is not enough for the agent use case.

Avoid requiring users to configure multiple paid providers for a single narrow feature. If a feature can run with a mock/local agent, document that path first and list paid STT/TTS/LLM providers as optional upgrades.

## Example Root `.env`

```env
GROQ_API_KEY=your-groq-api-key
GROQ_STT_MODEL=whisper-large-v3
GROQ_STT_LANGUAGE=zh

MINIMAX_API_KEY=your-minimax-api-key
MINIMAX_MODEL=speech-2.8-hd
MINIMAX_LLM_MODEL=MiniMax-M3

LLM_URL=
LLM_API_KEY=
LLM_MODEL=
```

## Example Agent `.env`

```env
DISCORD_BOT_TOKEN=your-discord-bot-token
GUILD_ID=your-discord-guild-id
VOICE_CHANNEL_NAME=General
```
