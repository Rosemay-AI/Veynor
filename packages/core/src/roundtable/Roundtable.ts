import type { ParticipantId } from "../session/VoiceTurn.js";

export type MeetingObjectiveKind =
  | "answer_user"
  | "compare_options"
  | "debug_problem"
  | "make_decision"
  | "brainstorm"
  | "review_plan";

export type SpeakIntent =
  | "initial_position"
  | "evidence"
  | "risk"
  | "counterargument"
  | "implementation"
  | "clarify"
  | "challenge"
  | "summary"
  | "interrupt";

export type RoundtableState =
  | "idle"
  | "human_speaking"
  | "planning_queue"
  | "queue_waiting"
  | "agent_speaking"
  | "human_interrupt"
  | "closing"
  | "completed";

export interface MeetingObjective {
  kind: MeetingObjectiveKind;
  prompt: string;
  requiredOutput?: string;
  domains?: string[];
  requiredRoles?: string[];
}

export interface AgentProfile {
  id: string;
  displayName?: string;
  role: string;
  domains?: string[];
  voiceId?: string;
  ttsModel?: string;
  ttsSpeed?: number;
  ttsVolume?: number;
  ttsPitch?: number;
  maxSpeakMs?: number;
  canChallenge?: boolean;
  canSummarize?: boolean;
}

export interface FloorRequest {
  agentId: string;
  intent: SpeakIntent;
  reason: string;
  priority?: number;
  requestedAt?: number;
  maxSpeakMs?: number;
  round?: number;
}

export interface FloorGrant extends Required<FloorRequest> {
  floorToken: string;
}

export interface TranscriptEntry {
  speakerId: ParticipantId | string;
  speakerType: "human" | "agent" | "arbiter";
  text: string;
  intent?: SpeakIntent;
  timestamp: number;
  durationMs?: number;
}

export interface MeetingAgendaItem {
  id: string;
  agentId: string;
  intent: SpeakIntent;
  round: number;
  reason: string;
  status: "queued" | "completed" | "skipped";
}

export interface FloorEventRecord {
  agentId: string;
  intent: SpeakIntent;
  floorToken: string;
  round: number;
  grantedAt: number;
  releasedAt?: number;
  durationMs?: number;
}

export interface FloorRequestReviewRecord {
  agentId: string;
  intent: SpeakIntent;
  reason: string;
  accepted: boolean;
  score?: number;
  arbiterReasons?: string[];
  rejectionReason?: string;
  requestedAt: number;
  round: number;
}

export interface MeetingRecord {
  meetingId: string;
  objective: MeetingObjective;
  question: string;
  participants: NormalizedAgentProfile[];
  startedAt: number;
  endedAt?: number;
  state: RoundtableState;
  agenda: MeetingAgendaItem[];
  transcript: TranscriptEntry[];
  floorEvents: FloorEventRecord[];
  floorRequests: FloorRequestReviewRecord[];
  decisions: DecisionRecord[];
}

export type RoundtableSpeechRecord = Omit<TranscriptEntry, "timestamp"> & {
  floorToken: string;
  timestamp?: number;
};

export interface DecisionRecord {
  turnId: string;
  objective: MeetingObjective;
  question: string;
  finalAnswer: string;
  agreements: string[];
  disagreements: string[];
  risks: string[];
  nextActions: string[];
  transcriptRefs: string[];
  createdAt: string;
}

export interface AgentSpeechContext {
  turnId: string;
  objective: MeetingObjective;
  question: string;
  agent: NormalizedAgentProfile;
  intent: SpeakIntent;
  round: number;
  constraints: string[];
  transcript: TranscriptEntry[];
  signal?: AbortSignal;
}

export interface RoundtableAgentAdapter {
  speak(context: AgentSpeechContext): Promise<string | { text: string }>;
}

export type NormalizedAgentProfile = Required<
  Pick<
    AgentProfile,
    | "id"
    | "displayName"
    | "role"
    | "domains"
    | "voiceId"
    | "ttsModel"
    | "ttsSpeed"
    | "ttsVolume"
    | "ttsPitch"
    | "maxSpeakMs"
    | "canChallenge"
    | "canSummarize"
  >
>;

export class AgentRegistry {
  private readonly agents = new Map<string, { profile: NormalizedAgentProfile; adapter: RoundtableAgentAdapter }>();

  register(profile: AgentProfile, adapter: RoundtableAgentAdapter): void {
    if (!profile.id) throw new Error("Agent profile requires id");
    if (!adapter?.speak) throw new Error(`Agent ${profile.id} requires speak(adapter)`);
    this.agents.set(profile.id, { profile: normalizeProfile(profile), adapter });
  }

  get(agentId: string): { profile: NormalizedAgentProfile; adapter: RoundtableAgentAdapter } {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Unknown agent: ${agentId}`);
    return entry;
  }

  list(): NormalizedAgentProfile[] {
    return [...this.agents.values()].map((entry) => entry.profile);
  }

  selectForObjective(objective: MeetingObjective, maxAgents = 3): string[] {
    return [...this.agents.values()]
      .map((entry) => ({ entry, score: scoreProfile(entry.profile, objective) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.profile.id.localeCompare(b.entry.profile.id))
      .slice(0, maxAgents)
      .map((item) => item.entry.profile.id);
  }
}

export class FloorQueue {
  private queue: Required<FloorRequest>[] = [];
  private current: FloorGrant | null = null;
  private frozen = false;

  enqueue(request: FloorRequest): Required<FloorRequest> {
    const normalized = normalizeFloorRequest(request);
    this.queue.push(normalized);
    this.queue.sort((a, b) => b.priority - a.priority || a.requestedAt - b.requestedAt);
    return normalized;
  }

  grantNext(): FloorGrant | null {
    if (this.frozen) return null;
    if (this.current) return this.current;

    const next = this.queue.shift();
    if (!next) return null;

    this.current = { ...next, floorToken: makeId("floor") };
    return this.current;
  }

  release(floorToken: string): boolean {
    if (!this.current) return false;
    if (this.current.floorToken !== floorToken) return false;
    this.current = null;
    return true;
  }

  releaseCurrent(): FloorGrant | null {
    const current = this.current;
    this.current = null;
    return current;
  }

  freeze(reason = "human_interrupt"): { current: FloorGrant | null; queued: Required<FloorRequest>[]; reason: string } {
    this.frozen = true;
    return { current: this.current, queued: [...this.queue], reason };
  }

  resume(): void {
    this.frozen = false;
  }

  clear(): void {
    this.queue = [];
    this.current = null;
  }

  snapshot(): { frozen: boolean; current: FloorGrant | null; queue: Required<FloorRequest>[] } {
    return { frozen: this.frozen, current: this.current, queue: [...this.queue] };
  }
}

export interface RoundtableSessionOptions {
  objective: MeetingObjective;
  userText: string;
  registry: AgentRegistry;
  maxInitialSpeakers?: number;
  maxRebuttalRounds?: number;
  maxTotalMs?: number;
  signal?: AbortSignal;
}

export class RoundtableSession {
  readonly id = makeId("rt");
  readonly objective: MeetingObjective;
  readonly userText: string;
  readonly registry: AgentRegistry;
  readonly floor = new FloorQueue();
  readonly transcript: TranscriptEntry[] = [];
  readonly decisions: DecisionRecord[] = [];
  readonly meetingRecord: MeetingRecord;
  readonly maxInitialSpeakers: number;
  readonly maxRebuttalRounds: number;
  readonly maxTotalMs: number;
  readonly signal?: AbortSignal;
  readonly startedAt = Date.now();

  state: RoundtableState = "planning_queue";
  round = 0;

  private readonly spokenByRound = new Map<number, Set<string>>();

  constructor(options: RoundtableSessionOptions) {
    if (!options.objective?.kind) throw new Error("Roundtable objective requires kind");
    if (!options.userText) throw new Error("Roundtable session requires userText");

    this.objective = options.objective;
    this.userText = options.userText;
    this.registry = options.registry;
    this.maxInitialSpeakers = options.maxInitialSpeakers ?? 3;
    this.maxRebuttalRounds = options.maxRebuttalRounds ?? 1;
    this.maxTotalMs = options.maxTotalMs ?? 90_000;
    this.signal = options.signal;
    this.meetingRecord = {
      meetingId: this.id,
      objective: this.objective,
      question: this.userText,
      participants: this.registry.list(),
      startedAt: this.startedAt,
      state: this.state,
      agenda: [],
      transcript: this.transcript,
      floorEvents: [],
      floorRequests: [],
      decisions: this.decisions,
    };
  }

  planInitialQueue(agentIds?: string[]): string[] {
    this.ensureNotTerminal("plan initial queue");
    const selected = agentIds ?? this.registry.selectForObjective(this.objective, this.maxInitialSpeakers);
    for (const [index, agentId] of selected.slice(0, this.maxInitialSpeakers).entries()) {
      this.registry.get(agentId);
      const intent = index === 0 ? "initial_position" : "evidence";
      this.floor.enqueue({
        agentId,
        intent,
        reason: "initial round",
        priority: 100 - index,
        round: 0,
      });
      this.meetingRecord.agenda.push({
        id: `${this.id}:agenda:${index}`,
        agentId,
        intent,
        round: 0,
        reason: "initial round",
        status: "queued",
      });
    }
    this.state = "queue_waiting";
    this.syncMeetingState();
    return selected;
  }

  grantNextFloor(): FloorGrant | null {
    if (this.isTerminal()) return null;
    if (this.expired()) return null;
    const grant = this.floor.grantNext();
    if (grant) {
      this.state = "agent_speaking";
      this.meetingRecord.floorEvents.push({
        agentId: grant.agentId,
        intent: grant.intent,
        floorToken: grant.floorToken,
        round: grant.round,
        grantedAt: Date.now(),
      });
      this.syncMeetingState();
    }
    return grant;
  }

  async runGrantedFloor(grant: FloorGrant): Promise<{ agentId: string; text: string }> {
    this.ensureNotTerminal("run granted floor");
    this.throwIfAborted();
    if (this.state === "closing") throw new Error(`Roundtable session exceeded maxTotalMs (${this.maxTotalMs}ms)`);
    if (this.expired()) throw new Error(`Roundtable session exceeded maxTotalMs (${this.maxTotalMs}ms)`);
    const { profile, adapter } = this.registry.get(grant.agentId);
    const remainingTotalMs = Math.max(0, this.maxTotalMs - (Date.now() - this.startedAt));
    if (remainingTotalMs <= 0) throw new Error(`Roundtable session exceeded maxTotalMs (${this.maxTotalMs}ms)`);
    const maxSpeakMs = Math.max(1, Math.min(grant.maxSpeakMs, profile.maxSpeakMs, remainingTotalMs));
    const speechSignal = createTimeoutSignal(this.signal, maxSpeakMs);
    const context = this.buildAgentContext(grant, profile, speechSignal.signal);
    const startedAt = Date.now();
    let text = "";
    try {
      const response = await Promise.race([
        adapter.speak(context),
        rejectOnAbort(speechSignal.signal, `Agent ${grant.agentId} exceeded maxSpeakMs (${maxSpeakMs}ms)`),
      ]);
      text = normalizeSpeechResponse(response, grant.agentId);
      this.throwIfAborted();
    } catch (error) {
      this.releaseAbortedGrant(grant, Date.now() - startedAt);
      throw error;
    } finally {
      speechSignal.dispose();
    }

    this.recordSpeech({
      floorToken: grant.floorToken,
      speakerId: grant.agentId,
      speakerType: "agent",
      intent: grant.intent,
      text,
      durationMs: Date.now() - startedAt,
    });

    return { agentId: grant.agentId, text };
  }

  recordSpeech(entry: RoundtableSpeechRecord): void {
    this.ensureNotTerminal("record speech");
    if (!this.floor.release(entry.floorToken)) throw new Error("Invalid or stale floor token");
    const timestamp = entry.timestamp ?? Date.now();
    const durationMs = entry.durationMs ?? 0;

    this.transcript.push({
      speakerId: entry.speakerId,
      speakerType: entry.speakerType,
      intent: entry.intent,
      text: entry.text,
      timestamp,
      durationMs,
    });

    const floorEvent = [...this.meetingRecord.floorEvents]
      .reverse()
      .find((event) => event.floorToken === entry.floorToken);
    if (floorEvent) {
      floorEvent.releasedAt = timestamp;
      floorEvent.durationMs = durationMs;
    }

    const agendaItem = this.meetingRecord.agenda.find(
      (item) => item.agentId === String(entry.speakerId) && item.round === this.round && item.intent === entry.intent,
    );
    if (agendaItem) agendaItem.status = "completed";

    const spoken = this.spokenByRound.get(this.round) ?? new Set<string>();
    spoken.add(String(entry.speakerId));
    this.spokenByRound.set(this.round, spoken);
    this.state = "queue_waiting";
    this.syncMeetingState();
  }

  requestFloor(request: FloorRequest): { accepted: true; request: Required<FloorRequest> } | { accepted: false; reason: string } {
    if (this.isTerminal()) return { accepted: false, reason: "session already completed" };
    this.registry.get(request.agentId);
    if (this.round > this.maxRebuttalRounds) return { accepted: false, reason: "max rounds reached" };

    const currentAgentId = this.floor.snapshot().current?.agentId;
    if (currentAgentId === request.agentId) return { accepted: false, reason: "agent is currently speaking" };

    const spoken = this.spokenByRound.get(this.round) ?? new Set<string>();
    if (spoken.has(request.agentId)) return { accepted: false, reason: "agent already spoke this round" };

    const queued = this.floor.snapshot().queue.some((item) => item.agentId === request.agentId && item.round === this.round);
    if (queued) return { accepted: false, reason: "agent already queued this round" };

    const queuedRequest = this.floor.enqueue({ ...request, round: this.round, priority: request.priority ?? 50 });
    this.meetingRecord.agenda.push({
      id: `${this.id}:agenda:${this.meetingRecord.agenda.length}`,
      agentId: queuedRequest.agentId,
      intent: queuedRequest.intent,
      round: queuedRequest.round,
      reason: queuedRequest.reason,
      status: "queued",
    });
    return { accepted: true, request: queuedRequest };
  }

  recordFloorRequestReview(review: Omit<FloorRequestReviewRecord, "requestedAt" | "round"> & Partial<Pick<FloorRequestReviewRecord, "requestedAt" | "round">>): void {
    if (this.isTerminal()) return;
    this.meetingRecord.floorRequests.push({
      agentId: review.agentId,
      intent: review.intent,
      reason: review.reason,
      accepted: review.accepted,
      score: review.score,
      arbiterReasons: review.arbiterReasons,
      rejectionReason: review.rejectionReason,
      requestedAt: review.requestedAt ?? Date.now(),
      round: review.round ?? this.round,
    });
  }

  nextRound(): boolean {
    if (this.isTerminal()) return false;
    if (this.round >= this.maxRebuttalRounds) return false;
    this.round += 1;
    this.state = "queue_waiting";
    this.syncMeetingState();
    return true;
  }

  interrupt(humanText: string): { current: FloorGrant | null; queued: Required<FloorRequest>[]; reason: string } {
    this.ensureNotTerminal("interrupt");
    const frozen = this.floor.freeze("human_interrupt");
    this.transcript.push({
      speakerId: "human",
      speakerType: "human",
      intent: "interrupt",
      text: humanText,
      timestamp: Date.now(),
      durationMs: 0,
    });
    this.state = "human_interrupt";
    this.syncMeetingState();
    return frozen;
  }

  resumeAfterInterrupt(): void {
    this.ensureNotTerminal("resume after interrupt");
    this.floor.resume();
    this.state = "queue_waiting";
    this.syncMeetingState();
  }

  close(finalAnswer: string, extra: Partial<Omit<DecisionRecord, "turnId" | "objective" | "question" | "finalAnswer" | "transcriptRefs" | "createdAt">> = {}): DecisionRecord {
    if (this.state === "completed") {
      const existing = this.decisions.at(-1);
      if (existing) return existing;
    }
    this.floor.clear();
    this.state = "completed";

    const record: DecisionRecord = {
      turnId: this.id,
      objective: this.objective,
      question: this.userText,
      finalAnswer,
      agreements: extra.agreements ?? [],
      disagreements: extra.disagreements ?? [],
      risks: extra.risks ?? [],
      nextActions: extra.nextActions ?? [],
      transcriptRefs: this.transcript.map((entry, index) => `${index}:${entry.speakerId}:${entry.intent ?? "none"}`),
      createdAt: new Date().toISOString(),
    };

    this.decisions.push(record);
    this.meetingRecord.endedAt = Date.now();
    this.syncMeetingState();
    return record;
  }

  private buildAgentContext(grant: FloorGrant, profile: NormalizedAgentProfile, signal?: AbortSignal): AgentSpeechContext {
    return {
      turnId: this.id,
      objective: this.objective,
      question: this.userText,
      agent: profile,
      intent: grant.intent,
      round: grant.round,
      constraints: [
        "Speak only for the assigned intent.",
        "Do not repeat earlier transcript unless correcting it.",
        "Do not address another agent directly unless the floor request asks for it.",
      ],
      transcript: [...this.transcript],
      signal,
    };
  }

  private expired(): boolean {
    if (Date.now() - this.startedAt <= this.maxTotalMs) return false;
    this.state = "closing";
    this.floor.clear();
    this.syncMeetingState();
    return true;
  }

  private syncMeetingState(): void {
    this.meetingRecord.state = this.state;
  }

  private throwIfAborted(): void {
    if (!this.signal?.aborted) return;
    this.interrupt("aborted");
    throw new Error("Roundtable turn aborted");
  }

  private releaseAbortedGrant(grant: FloorGrant, durationMs: number): void {
    this.floor.releaseCurrent();
    const timestamp = Date.now();
    const floorEvent = [...this.meetingRecord.floorEvents]
      .reverse()
      .find((event) => event.floorToken === grant.floorToken);
    if (floorEvent) {
      floorEvent.releasedAt = timestamp;
      floorEvent.durationMs = durationMs;
    }
    const agendaItem = this.meetingRecord.agenda.find(
      (item) => item.agentId === grant.agentId && item.round === grant.round && item.intent === grant.intent,
    );
    if (agendaItem) agendaItem.status = "skipped";
    this.state = this.signal?.aborted ? "human_interrupt" : "queue_waiting";
    this.syncMeetingState();
  }

  private isTerminal(): boolean {
    return this.state === "completed";
  }

  private ensureNotTerminal(action: string): void {
    if (this.isTerminal()) throw new Error(`Cannot ${action}: roundtable session is completed`);
  }
}

function normalizeSpeechResponse(response: string | { text: string }, agentId: string): string {
  const text = typeof response === "string" ? response : response?.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error(`Agent ${agentId} returned empty speech text`);
  }
  return text;
}

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

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

function rejectOnAbort(signal: AbortSignal, message: string): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error(message));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error(message)), { once: true });
  });
}

function normalizeProfile(profile: AgentProfile): NormalizedAgentProfile {
  return {
    id: profile.id,
    displayName: profile.displayName ?? profile.id,
    role: profile.role,
    domains: profile.domains ?? [],
    voiceId: profile.voiceId ?? "default",
    ttsModel: profile.ttsModel ?? "",
    ttsSpeed: profile.ttsSpeed ?? 1,
    ttsVolume: profile.ttsVolume ?? 1,
    ttsPitch: profile.ttsPitch ?? 0,
    maxSpeakMs: profile.maxSpeakMs ?? 20_000,
    canChallenge: profile.canChallenge ?? true,
    canSummarize: profile.canSummarize ?? false,
  };
}

function normalizeFloorRequest(request: FloorRequest): Required<FloorRequest> {
  if (!request.agentId) throw new Error("Floor request requires agentId");
  return {
    agentId: request.agentId,
    intent: request.intent,
    reason: request.reason,
    priority: request.priority ?? 50,
    requestedAt: request.requestedAt ?? Date.now(),
    maxSpeakMs: request.maxSpeakMs ?? 20_000,
    round: request.round ?? 0,
  };
}

function scoreProfile(profile: NormalizedAgentProfile, objective: MeetingObjective): number {
  const haystack = [profile.role, ...profile.domains].join(" ").toLowerCase();
  const terms = [objective.kind, ...(objective.domains ?? []), ...(objective.requiredRoles ?? [])]
    .filter(Boolean)
    .map((term) => String(term).toLowerCase());
  // Baseline keeps generic agents eligible when no specialist matches.
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 10 : 0), 1);
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
