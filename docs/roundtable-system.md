# Veynor Roundtable System

The roundtable mechanism belongs to Veynor core, not to any Discord bot. A bot, WebRTC app, or other transport should consume the same protocol.

## Principle

The voice channel is the meeting room. The floor queue is the protocol. Agents can speak with their own voices, but only after Veynor grants the floor.

## Core Rules

- Every meeting has an objective.
- Every agent speech has an intent.
- Every speaker needs a floor token.
- Only one floor token can be active at a time.
- Agent speech can update transcript, but cannot directly create a new user turn.
- Human interrupt freezes the queue and wins over agent speech.
- A meeting ends by queue exhaustion, timeout, max rounds, or explicit close.
- Every meeting maintains a `MeetingRecord`.
- Every completed meeting emits a `DecisionRecord`.

## Runtime Flow

```text
Human asks
  -> MeetingObjective
  -> Agent selection
  -> FloorQueue
  -> Agent speaks with assigned intent
  -> Transcript updated
  -> Floor requests reviewed
  -> Rebuttal / clarification round
  -> MeetingRecord updated
  -> DecisionRecord
  -> Final spoken close + text summary
```

## Integration Boundary

`@veynor/core` owns the protocol primitives:

- `AgentRegistry`
- `FloorQueue`
- `RoundtableSession`
- `MeetingRecord`
- `TranscriptEntry`
- `DecisionRecord`

`@veynor/agent` should own runtime adapters, agent invocation, and TTS playback.

Transport packages such as Discord should only provide audio I/O and speaker identity; they should not decide meeting policy.

## Agent Runtime Layer

`@veynor/agent` provides `RoundtableRuntime`.

It consumes Veynor core primitives and produces ordered speech events:

```text
RoundtableRuntime.runTurn()
  -> RoundtableSession.planInitialQueue()
  -> grant floor
  -> call selected agent
  -> record transcript
  -> emit speech hook
  -> repeat
  -> emit DecisionRecord
```

The runtime still does not own Discord. A Discord bot should attach TTS playback to `onSpeech`, using the granted agent profile voice.

## Voice Turn Integration

`VeynorSkill` can enable roundtable mode through its constructor:

```ts
const skill = new VeynorSkill(defaultAgent, {
  groqApiKey,
  minimaxApiKey,
  roundtable: {
    agents: [
      { id: "architect", role: "architect", domains: ["runtime"], voiceId: "voice-a", agent: architectAgent },
      { id: "critic", role: "critic", domains: ["risk"], voiceId: "voice-b", ttsPitch: 1, agent: criticAgent },
    ],
    objective: (text) => ({
      kind: "review_plan",
      prompt: text,
      requiredOutput: "Ordered spoken contributions and a decision record.",
    }),
  },
});
```

When enabled, a human utterance follows this path:

```text
STT text
  -> RoundtableRuntime.runTurn()
  -> floor grant
  -> agent contribution
  -> VeynorSkill TTS playback
  -> next floor grant
  -> DecisionRecord
```

Single-agent mode remains the default when `roundtable` is not configured.

## Per-Agent Voice

Roundtable agent profiles carry their own voice settings:

```ts
{
  id: "critic",
  role: "critic",
  voiceId: "critic-voice",
  ttsModel: "speech-2.8-hd",
  ttsSpeed: 1.05,
  ttsVolume: 1,
  ttsPitch: 1,
  agent: criticAgent,
}
```

`VeynorSkill` uses these settings when playing each `RoundtableSpeech`. This keeps the floor protocol and voice identity aligned: the agent that owns the floor also owns the voice used for that spoken turn.

## Floor Requests

Agents can request another speaking slot after reading the transcript, but they still cannot speak directly.

```ts
{
  id: "critic",
  role: "critic",
  agent: criticAgent,
  async requestFloor(context) {
    if (context.round !== 1) return [];
    return [{
      intent: "challenge",
      reason: "Add a rebuttal after the initial positions.",
      priority: 90,
    }];
  },
}
```

Runtime rules:

- The agent that just spoke is not asked to request the floor immediately.
- An agent cannot be queued twice in the same round.
- An agent cannot speak twice in the same round.
- `maxRebuttalRounds` bounds the number of follow-up rounds.
- A rejected request is observable through `onFloorRequest`, but does not affect playback.

## Floor Arbiter

`RoundtableRuntime` includes a deterministic arbiter before a floor request enters the queue.

The arbiter scores each proposal using:

- Intent permission: for example, `challenge` requires `canChallenge`.
- Reason quality: vague reasons are penalized.
- Relevance: the proposal should overlap with the objective, user question, or recent transcript.
- Novelty: repeated points are penalized.
- Priority: high-priority requests get a bounded bonus.

The default minimum score is `3`. A rejected request records its reason in `onFloorRequest`, so transports and logs can show why an agent was not granted another turn.

The built-in arbiter is a deterministic baseline for local demos and predictable tests. Production systems can replace it with an LLM arbiter through `RoundtableRuntimeOptions.arbiter`.

This keeps multi-agent voice discussion bounded: agents can ask to speak, but Veynor decides whether that request advances the meeting.

Agents that need LLM-based self-evaluation can call `context.evaluate(prompt)` inside `requestFloor`. The evaluation runs through that same agent and receives the active turn `AbortSignal`.

## Meeting Record

`MeetingRecord` is the structured record of the roundtable session. It is not only a text log.

It contains:

- `objective`: what the meeting is trying to solve.
- `participants`: the normalized agent profiles in the room.
- `agenda`: the planned speaking slots and accepted follow-up slots.
- `transcript`: every human, agent, and arbiter utterance.
- `floorEvents`: when each floor token was granted and released.
- `floorRequests`: accepted and rejected agent requests to speak, including scores and arbiter reasons.
- `decisions`: final `DecisionRecord` entries.

This gives Veynor replayability and auditability:

```text
MeetingRecord
  -> who attended
  -> who was supposed to speak
  -> who actually spoke
  -> who asked to speak again
  -> why the arbiter accepted or rejected that request
  -> how the final decision was produced
```

Project planning agents can later turn the same record into meeting minutes, MVP plans, implementation tasks, or follow-up meeting context.
