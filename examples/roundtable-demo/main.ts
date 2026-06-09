import { RoundtableRuntime, type Agent } from "@veynor/agent";

function scriptedAgent(label: string): Agent {
  return {
    async chat(prompt) {
      const intent = prompt.match(/Your speaking intent: (.+)/)?.[1] ?? "unknown";
      return `${label} contribution for ${intent}.`;
    },
  };
}

const runtime = new RoundtableRuntime({
  agents: [
    {
      id: "architect",
      role: "architect",
      domains: ["architecture", "runtime"],
      voiceId: "architect-voice",
      ttsSpeed: 0.95,
      ttsPitch: -1,
      agent: scriptedAgent("Architect"),
    },
    {
      id: "critic",
      role: "critic",
      domains: ["risk", "review_plan"],
      voiceId: "critic-voice",
      ttsSpeed: 1.05,
      ttsPitch: 1,
      agent: scriptedAgent("Critic"),
      async requestFloor(context) {
        if (context.round !== 1) return [];
        return [
          {
            intent: "challenge",
            reason: "Challenge the runtime risk: the floor queue still needs interrupt handling and timeout limits.",
            priority: 90,
          },
        ];
      },
    },
    {
      id: "implementer",
      role: "implementer",
      domains: ["implementation", "runtime"],
      voiceId: "implementer-voice",
      ttsSpeed: 1,
      ttsPitch: 0,
      agent: scriptedAgent("Implementer"),
    },
  ],
  hooks: {
    onSpeech(speech) {
      console.log(`[${speech.agentId}] ${speech.text}`);
    },
    onFloorRequest(decision) {
      console.log(
        `[floor-request] ${decision.agentId} ${decision.intent}: ${
          decision.accepted ? "accepted" : `rejected (${decision.rejectionReason})`
        } score=${decision.score} reasons=${decision.arbiterReasons.join("; ")}`,
      );
    },
    onDecision(decision) {
      console.log("\nDecisionRecord");
      console.log(JSON.stringify(decision, null, 2));
    },
  },
});

const result = await runtime.runTurn({
  objective: {
    kind: "review_plan",
    prompt: "Review the roundtable voice design.",
    requiredOutput: "A practical decision and next steps.",
    domains: ["runtime", "risk", "implementation"],
  },
  userText: "How should multiple agents share one voice channel without speaking over each other?",
});

console.log("\nMeetingRecord");
console.log(
  JSON.stringify(
    {
      meetingId: result.meetingRecord.meetingId,
      state: result.meetingRecord.state,
      agenda: result.meetingRecord.agenda,
      floorEvents: result.meetingRecord.floorEvents,
      floorRequests: result.meetingRecord.floorRequests,
      transcriptCount: result.meetingRecord.transcript.length,
      decisionCount: result.meetingRecord.decisions.length,
    },
    null,
    2,
  ),
);
