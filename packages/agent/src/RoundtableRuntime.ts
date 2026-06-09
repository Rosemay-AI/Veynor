import {
  AgentRegistry,
  RoundtableSession,
  type AgentProfile,
  type AgentSpeechContext,
  type DecisionRecord,
  type FloorGrant,
  type FloorRequest,
  type MeetingRecord,
  type MeetingObjective,
  type NormalizedAgentProfile,
  type RoundtableAgentAdapter,
  type SpeakIntent,
  type TranscriptEntry,
} from "@veynor/core";
import type { Agent } from "./types.js";

export type RoundtableAgent = AgentProfile & {
  agent: Agent;
  requestFloor?: (context: RoundtableFloorRequestContext) => Promise<RoundtableFloorRequestProposal[]>;
};

export type RoundtableFloorRequestContext = {
  turnId: string;
  objective: MeetingObjective;
  question: string;
  agent: NormalizedAgentProfile;
  round: number;
  transcript: TranscriptEntry[];
  lastSpeech: RoundtableSpeech | null;
  evaluate: (prompt: string) => Promise<string>;
  queueState: {
    currentAgentId: string | null;
    queuedAgentIds: string[];
  };
};

export type RoundtableFloorRequestProposal = {
  intent: SpeakIntent;
  reason: string;
  priority?: number;
  maxSpeakMs?: number;
};

export type RoundtableFloorRequestEvaluation = {
  accepted: boolean;
  score: number;
  reasons: string[];
};

export type RoundtableFloorRequestArbiter = (
  proposal: RoundtableFloorRequestProposal,
  context: RoundtableFloorRequestContext,
) => RoundtableFloorRequestEvaluation | Promise<RoundtableFloorRequestEvaluation>;

export type RoundtableTurnInput = {
  objective: MeetingObjective;
  userText: string;
  participantId?: string;
  agentIds?: string[];
  signal?: AbortSignal;
};

export type RoundtableSpeech = {
  turnId: string;
  agentId: string;
  agent: NormalizedAgentProfile;
  grant: FloorGrant;
  text: string;
  transcript: TranscriptEntry[];
};

export type RoundtableFloorRequestDecision = {
  agentId: string;
  accepted: boolean;
  intent: SpeakIntent;
  reason: string;
  score: number;
  arbiterReasons: string[];
  rejectionReason?: string;
};

export type RoundtableResult = {
  session: RoundtableSession;
  meetingRecord: MeetingRecord;
  speeches: RoundtableSpeech[];
  floorRequests: RoundtableFloorRequestDecision[];
  decision: DecisionRecord;
};

export type RoundtableRuntimeHooks = {
  onFloorGranted?: (grant: FloorGrant, context: AgentSpeechContext) => void | Promise<void>;
  onFloorRequest?: (decision: RoundtableFloorRequestDecision) => void | Promise<void>;
  onSpeech?: (speech: RoundtableSpeech) => void | Promise<void>;
  onDecision?: (decision: DecisionRecord) => void | Promise<void>;
};

export type RoundtableRuntimeOptions = {
  agents: RoundtableAgent[];
  maxInitialSpeakers?: number;
  maxRebuttalRounds?: number;
  maxTotalMs?: number;
  minFloorRequestScore?: number;
  arbiter?: RoundtableFloorRequestArbiter;
  hooks?: RoundtableRuntimeHooks;
};

export class RoundtableRuntime {
  readonly registry = new AgentRegistry();
  private readonly hooks: RoundtableRuntimeHooks;
  private readonly maxInitialSpeakers: number;
  private readonly maxRebuttalRounds: number;
  private readonly maxTotalMs: number;
  private readonly minFloorRequestScore: number;
  private readonly arbiter: RoundtableFloorRequestArbiter;
  private readonly agents: RoundtableAgent[];

  constructor(options: RoundtableRuntimeOptions) {
    if (options.agents.length === 0) {
      throw new Error("RoundtableRuntime requires at least one agent");
    }

    this.hooks = options.hooks ?? {};
    this.maxInitialSpeakers = options.maxInitialSpeakers ?? 3;
    this.maxRebuttalRounds = options.maxRebuttalRounds ?? 1;
    this.maxTotalMs = options.maxTotalMs ?? 90_000;
    this.minFloorRequestScore = options.minFloorRequestScore ?? 4;
    this.arbiter = options.arbiter ?? ((proposal, context) => this.defaultEvaluateFloorRequest(proposal, context));
    this.agents = options.agents;

    for (const entry of options.agents) {
      const { agent, ...profile } = entry;
      this.registry.register(profile, this.createAdapter(profile.id, agent));
    }
  }

  async runTurn(input: RoundtableTurnInput): Promise<RoundtableResult> {
    if (input.signal?.aborted) {
      throw new Error("Roundtable turn was aborted before start");
    }

    const turnTimeout = createTimeoutSignal(input.signal, this.maxTotalMs);
    const session = new RoundtableSession({
      objective: input.objective,
      userText: input.userText,
      registry: this.registry,
      maxInitialSpeakers: this.maxInitialSpeakers,
      maxRebuttalRounds: this.maxRebuttalRounds,
      maxTotalMs: this.maxTotalMs,
      signal: turnTimeout.signal,
    });

    const speeches: RoundtableSpeech[] = [];
    const floorRequests: RoundtableFloorRequestDecision[] = [];
    try {
      session.planInitialQueue(input.agentIds);

      let grant = session.grantNextFloor();
      while (grant) {
        if (turnTimeout.signal.aborted) break;

        const { profile } = this.registry.get(grant.agentId);
        const context = this.createSpeechContext(session, grant, profile);
        await Promise.race([
          this.hooks.onFloorGranted?.(grant, context),
          rejectOnAbort(turnTimeout.signal, "Roundtable turn exceeded maxTotalMs while granting floor"),
        ]);

        let result: { agentId: string; text: string };
        try {
          result = await session.runGrantedFloor(grant);
        } catch (error) {
          if (turnTimeout.signal.aborted) break;
          throw error;
        }

        const speech: RoundtableSpeech = {
          turnId: session.id,
          agentId: result.agentId,
          agent: profile,
          grant,
          text: result.text,
          transcript: [...session.transcript],
        };
        speeches.push(speech);
        await Promise.race([
          this.hooks.onSpeech?.(speech),
          rejectOnAbort(turnTimeout.signal, "Roundtable turn exceeded maxTotalMs while handling speech"),
        ]);

        try {
          floorRequests.push(...(await this.collectFloorRequests(session, speech)));
        } catch (error) {
          if (turnTimeout.signal.aborted) break;
          throw error;
        }

        grant = session.grantNextFloor();
        if (!grant) {
          const advanced = session.nextRound();
          if (advanced) {
            try {
              floorRequests.push(...(await this.collectFloorRequests(session, null)));
            } catch (error) {
              if (turnTimeout.signal.aborted) break;
              throw error;
            }
            grant = session.grantNextFloor();
          }
        }
      }

      const decision = session.close(this.buildDefaultFinalAnswer(input.userText, speeches));
      await Promise.race([
        this.hooks.onDecision?.(decision),
        rejectOnAbort(turnTimeout.signal, "Roundtable turn exceeded maxTotalMs while handling decision"),
      ]).catch((error) => {
        if (!turnTimeout.signal.aborted) throw error;
      });

      return { session, meetingRecord: session.meetingRecord, speeches, floorRequests, decision };
    } finally {
      turnTimeout.dispose();
    }
  }

  private createAdapter(agentId: string, agent: Agent): RoundtableAgentAdapter {
    return {
      speak: async (context) => {
        const prompt = renderAgentPrompt(context);
        return agent.chat(prompt, `roundtable:${context.turnId}:${agentId}`, context.signal);
      },
    };
  }

  private createSpeechContext(
    session: RoundtableSession,
    grant: FloorGrant,
    profile: AgentSpeechContext["agent"],
  ): AgentSpeechContext {
    return {
      turnId: session.id,
      objective: session.objective,
      question: session.userText,
      agent: profile,
      intent: grant.intent,
      round: grant.round,
      constraints: [
        "Speak only for the assigned intent.",
        "Do not repeat earlier transcript unless correcting it.",
        "Do not address another agent directly unless the floor request asks for it.",
      ],
      transcript: [...session.transcript],
      signal: session.signal,
    };
  }

  private buildDefaultFinalAnswer(userText: string, speeches: RoundtableSpeech[]): string {
    if (speeches.length === 0) {
      return `No agent produced a response for: ${userText}`;
    }

    return speeches.map((speech) => `${speech.agentId}: ${speech.text}`).join("\n\n");
  }

  private async collectFloorRequests(
    session: RoundtableSession,
    lastSpeech: RoundtableSpeech | null,
  ): Promise<RoundtableFloorRequestDecision[]> {
    const decisions: RoundtableFloorRequestDecision[] = [];
    const proposalBatches = await Promise.all(
      this.agents
        .filter((entry) => entry.requestFloor && lastSpeech?.agentId !== entry.id)
        .map(async (entry) => {
          const { profile } = this.registry.get(entry.id);
          const context = this.createFloorRequestContext(session, entry, profile, lastSpeech);
          const proposals = await Promise.race([
            entry.requestFloor?.(context),
            rejectOnAbort(session.signal, `Roundtable floor request timed out for agent ${entry.id}`),
          ]);
          return { entry, context, proposals: proposals ?? [] };
        }),
    );

    for (const { entry, context, proposals } of proposalBatches) {
      for (const proposal of proposals) {
        const evaluation = await this.arbiter(proposal, context);
        if (!evaluation.accepted || evaluation.score < this.minFloorRequestScore) {
          const decision: RoundtableFloorRequestDecision = {
            agentId: entry.id,
            accepted: false,
            intent: proposal.intent,
            reason: proposal.reason,
            score: evaluation.score,
            arbiterReasons: evaluation.reasons,
            rejectionReason: "arbiter rejected request",
          };
          session.recordFloorRequestReview(decision);
          decisions.push(decision);
          await this.hooks.onFloorRequest?.(decision);
          continue;
        }

        const request: FloorRequest = {
          agentId: entry.id,
          intent: proposal.intent,
          reason: proposal.reason,
          priority: proposal.priority ?? 50,
          maxSpeakMs: proposal.maxSpeakMs,
        };
        const result = session.requestFloor(request);
        const decision: RoundtableFloorRequestDecision =
          result.accepted
            ? {
                agentId: entry.id,
                accepted: true,
                intent: proposal.intent,
                reason: proposal.reason,
                score: evaluation.score,
                arbiterReasons: evaluation.reasons,
              }
            : {
                agentId: entry.id,
                accepted: false,
                intent: proposal.intent,
                reason: proposal.reason,
                score: evaluation.score,
                arbiterReasons: evaluation.reasons,
                rejectionReason: result.reason,
              };
        session.recordFloorRequestReview(decision);
        decisions.push(decision);
        await this.hooks.onFloorRequest?.(decision);
      }
    }

    return decisions;
  }

  private createFloorRequestContext(
    session: RoundtableSession,
    entry: RoundtableAgent,
    profile: NormalizedAgentProfile,
    lastSpeech: RoundtableSpeech | null,
  ): RoundtableFloorRequestContext {
    const queue = session.floor.snapshot();
    return {
      turnId: session.id,
      objective: session.objective,
      question: session.userText,
      agent: profile,
      round: session.round,
      transcript: [...session.transcript],
      lastSpeech,
      evaluate: (prompt) => entry.agent.chat(prompt, `roundtable-request:${session.id}:${entry.id}`, session.signal),
      queueState: {
        currentAgentId: queue.current?.agentId ?? null,
        queuedAgentIds: queue.queue.map((request) => request.agentId),
      },
    };
  }

  private defaultEvaluateFloorRequest(
    proposal: RoundtableFloorRequestProposal,
    context: RoundtableFloorRequestContext,
  ): RoundtableFloorRequestEvaluation {
    const reasons: string[] = [];
    let score = 0;

    const reason = proposal.reason.trim();
    if (reason.length >= 12) {
      score += 1;
      reasons.push("reason is specific enough");
    } else {
      reasons.push("reason is too short");
    }

    if (isIntentAllowed(proposal.intent, context.agent)) {
      score += 1;
      reasons.push("intent is allowed for agent");
    } else {
      reasons.push(`intent ${proposal.intent} is not allowed for agent`);
    }

    const relevance = relevanceScore(reason, context);
    score += relevance.score;
    reasons.push(...relevance.reasons);

    const novelty = noveltyScore(reason, context.transcript);
    score += novelty.score;
    reasons.push(...novelty.reasons);

    const priority = proposal.priority ?? 50;
    if (priority >= 80) {
      score += 1;
      reasons.push("high priority request");
    }

    return {
      accepted: score >= this.minFloorRequestScore && isIntentAllowed(proposal.intent, context.agent),
      score,
      reasons,
    };
  }
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

function rejectOnAbort(signal: AbortSignal | undefined, message: string): Promise<never> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.reject(new Error(message));
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error(message)), { once: true });
  });
}

function renderAgentPrompt(context: AgentSpeechContext): string {
  const transcript = context.transcript.length
    ? context.transcript
        .map((entry) => `${entry.speakerId} (${entry.intent ?? "none"}): ${entry.text}`)
        .join("\n")
    : "(no previous agent speech)";

  return [
    `Roundtable objective: ${context.objective.kind}`,
    `Required output: ${context.objective.requiredOutput ?? "answer the user"}`,
    `User question: ${context.question}`,
    `Your agent id: ${context.agent.id}`,
    `Your role: ${context.agent.role}`,
    `Your speaking intent: ${context.intent}`,
    `Round: ${context.round}`,
    "Constraints:",
    ...context.constraints.map((item) => `- ${item}`),
    "Transcript so far:",
    transcript,
    "Now provide your spoken contribution.",
  ].join("\n");
}

function isIntentAllowed(intent: SpeakIntent, agent: NormalizedAgentProfile): boolean {
  if ((intent === "challenge" || intent === "counterargument") && !agent.canChallenge) return false;
  if (intent === "summary" && !agent.canSummarize) return false;
  return true;
}

function relevanceScore(
  reason: string,
  context: RoundtableFloorRequestContext,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const requestTokens = tokenize(reason);
  const targetTokens = new Set(
    tokenize(
      [
        context.question,
        context.objective.prompt,
        context.objective.requiredOutput ?? "",
        ...(context.objective.domains ?? []),
        context.lastSpeech?.text ?? "",
      ].join(" "),
    ),
  );

  const overlap = requestTokens.filter((token) => targetTokens.has(token));
  if (overlap.length > 0) {
    reasons.push(`relevant overlap: ${overlap.slice(0, 4).join(", ")}`);
    return { score: Math.min(2, overlap.length), reasons };
  }

  reasons.push("no clear relevance overlap");
  return { score: 0, reasons };
}

function noveltyScore(reason: string, transcript: TranscriptEntry[]): { score: number; reasons: string[] } {
  const requestTokens = new Set(tokenize(reason));
  if (requestTokens.size === 0) return { score: 0, reasons: ["no novelty tokens"] };

  const transcriptTokens = new Set(tokenize(transcript.map((entry) => entry.text).join(" ")));
  let overlap = 0;
  for (const token of requestTokens) {
    if (transcriptTokens.has(token)) overlap++;
  }

  const overlapRatio = overlap / requestTokens.size;
  if (overlapRatio < 0.7) {
    return { score: 1, reasons: ["request appears to add new information"] };
  }

  return { score: 0, reasons: ["request appears repetitive"] };
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_@./:-]+|[\u4e00-\u9fff]{2,}/g) ?? []).filter((token) => token.length > 1);
}
