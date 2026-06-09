import { loadLocalRoundtableAgents, RoundtableRuntime } from "@veynor/agent";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = dirname(fileURLToPath(import.meta.url));

const agents = await loadLocalRoundtableAgents({
  cwd,
  registryPath: "registry.fixture.json",
  meetingPath: "meeting.fixture.json",
});

const runtime = new RoundtableRuntime({
  agents,
  hooks: {
    onSpeech(speech) {
      console.log(`[${speech.agentId}] ${speech.text}`);
    },
  },
});

const result = await runtime.runTurn({
  objective: {
    kind: "review_plan",
    prompt: "Review local agent registry loading.",
    requiredOutput: "Confirm selected registry agents can enter a roundtable.",
    domains: ["architecture", "risk"],
  },
  userText: "Can selected local agents enter this meeting?",
});

console.log(JSON.stringify({
  selected: agents.map((agent) => agent.id),
  speeches: result.speeches.length,
  decisionRefs: result.decision.transcriptRefs,
}, null, 2));
