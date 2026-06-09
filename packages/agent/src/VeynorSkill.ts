import type { AudioFrame, Utterance, VoiceTurnContext } from "@veynor/core";
import { DefaultAudioSession, TurnState } from "@veynor/core";
import { DiscordVoiceTransport } from "@veynor/transport-discord";
import type { Agent, VoiceConnectConfig } from "./types.js";
import type { Message } from "discord.js";
import { BargeInController, computeRms } from "./BargeInController.js";
import { RoundtableRuntime, type RoundtableAgent } from "./RoundtableRuntime.js";
import { loadLocalRoundtableAgents, type LoadLocalRoundtableAgentsOptions } from "./LocalAgentRegistry.js";
import type { MeetingObjective } from "@veynor/core";

type TtsVoiceProfile = {
  model?: string;
  voiceId?: string;
  speed?: number;
  volume?: number;
  pitch?: number;
};

export type VeynorSkillRoundtableOptions = {
  agents?: RoundtableAgent[];
  localRegistry?: LoadLocalRoundtableAgentsOptions;
  objective?: (text: string, participantId: string) => MeetingObjective;
  maxInitialSpeakers?: number;
  maxRebuttalRounds?: number;
  maxTotalMs?: number;
};

export type VeynorSkillOptions = {
  groqApiKey?: string;
  minimaxApiKey?: string;
  transportId?: string;
  loudnessGate?: number;
  postTtsCooldownMs?: number;
  vadEnabled?: boolean;
  noSpeechThreshold?: number;
  minimaxModel?: string;
  roundtable?: VeynorSkillRoundtableOptions;
};

function pcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const dataSize = pcm.length;
  const fileSize = 36 + dataSize;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Common conversational backchannels across zh/en. After STT, if the
 * transcribed text is only one of these, it is a listening signal rather
 * than a question, so skip the LLM call.
 */
const BACKCHANNELS_ZH = [
  "\u55ef", "\u554a", "\u54e6", "\u5662", "\u5594", "\u55f7", "\u54ce", "\u6b38", "\u8bf6",
  "\u55ef\u55ef", "\u554a\u554a", "\u54e6\u54e6", "\u662f\u662f", "\u5bf9\u5bf9",
  "\u8fd9\u6837", "\u8fd9\u6837\u554a", "\u5bf9\u554a", "\u597d\u5462", "\u597d\u7684",
  "\u884c\u4e86",
];
const BACKCHANNELS_EN = [
  "yes", "yeah", "yea", "yep", "yup", "no", "nope", "nah",
  "ok", "okay", "k", "kk", "k.", "uh-huh", "uh huh", "mm-hmm", "mmhmm",
  "hmm", "mhm", "mm", "right", "alright", "sure", "yep",
  "i see", "got it", "gotcha", "cool", "nice", "great", "thanks", "thx", "ty",
];
function normalizeBackchannelText(text: string): string {
  return text.trim().toLowerCase().replace(/[.,!?。，！？、\s]/g, "");
}
const NORMALIZED_BACKCHANNELS = new Set([...BACKCHANNELS_ZH, ...BACKCHANNELS_EN].map(normalizeBackchannelText));
function isBackchannel(text: string): boolean {
  const normalized = normalizeBackchannelText(text);
  if (!normalized) return true;
  return NORMALIZED_BACKCHANNELS.has(normalized);
}
function resample48kStereoTo16kMono(pcm: Buffer): Buffer {
  const ratio = 48000 / 16000;
  const inputSamples = pcm.length / 4;
  const outputSamples = Math.floor(inputSamples / ratio);
  const out = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const srcIdx = Math.floor(i * ratio);
    const left = pcm.readInt16LE(srcIdx * 4);
    const right = pcm.readInt16LE(srcIdx * 4 + 2);
    out.writeInt16LE(Math.round((left + right) / 2), i * 2);
  }
  return out;
}

// Discord's hard cap on a single message body (2000 chars). A long LLM
// reply sent in one `channel.send()` call will be rejected; we split
// into chunks of this size and send them sequentially.
const DISCORD_MAX_MSG_LEN = 2000;

async function sendDiscordMessage(
  ch: { send?: (content: string) => Promise<unknown> },
  text: string
): Promise<void> {
  if (typeof ch.send !== "function") return;
  for (let i = 0; i < text.length; i += DISCORD_MAX_MSG_LEN) {
    await ch.send(text.slice(i, i + DISCORD_MAX_MSG_LEN));
  }
}

async function transcribe(
  pcm: Buffer,
  groqApiKey: string | null
): Promise<{ text: string; noSpeechProb: number }> {
  if (!groqApiKey) return { text: "", noSpeechProb: 1 };

  try {
    const mono16k = resample48kStereoTo16kMono(pcm);
    const wav = pcmToWav(mono16k, 16000, 1);
    const blob = new Blob([new Uint8Array(wav)], { type: "audio/wav" });
    const form = new FormData();
    form.append("file", blob, "audio.wav");
    form.append("model", "whisper-large-v3");
    form.append("language", "zh");
    // verbose_json gives us per-segment no_speech_prob which we use to
    // drop low-confidence transcripts that the RMS/ZCR gates miss.
    form.append("response_format", "verbose_json");

    const res = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${groqApiKey}` },
        body: form,
      }
    );
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      console.error(`[Whisper] HTTP ${res.status}: ${err}`);
      return { text: "", noSpeechProb: 1 };
    }
    const data = (await res.json()) as {
      text: string;
      segments?: Array<{ no_speech_prob: number }>;
    };
    const noSpeechProb = data.segments?.length
      ? Math.max(...data.segments.map((s) => s.no_speech_prob ?? 0))
      : 0;
    return { text: data.text?.trim() || "", noSpeechProb };
  } catch (e) {
    console.error("[Whisper] error:", e);
    return { text: "", noSpeechProb: 1 };
  }
}

function* pcm32kToFrames48k(pcm32k: Buffer): Generator<AudioFrame> {
  const frameSize = 960;
  const inRatio = 32000 / 48000;
  const bytesPerFrameOut = frameSize * 2 * 2;
  let srcSample = 0;

  while ((srcSample + 1) * 2 <= pcm32k.length) {
    const frame = Buffer.alloc(bytesPerFrameOut);
    for (let i = 0; i < frameSize; i++) {
      const srcIdx = Math.min(srcSample + Math.floor(i * inRatio), Math.floor((pcm32k.length - 2) / 2));
      const sample = pcm32k.readInt16LE(srcIdx * 2);
      frame.writeInt16LE(sample, i * 4);
      frame.writeInt16LE(sample, i * 4 + 2);
    }

    srcSample += Math.floor(frameSize * inRatio);
    if (srcSample * 2 > pcm32k.length) break;

    yield {
      sampleRate: 48000,
      channels: 2,
      bitDepth: 16,
      timestamp: Date.now(),
      data: frame,
    };
  }
}

async function minimaxTTS(text: string, apiKey: string | null, model: string, voice?: TtsVoiceProfile, signal?: AbortSignal): Promise<Buffer> {
  if (!apiKey) throw new Error("MiniMax API key not configured");
  const voiceId = voice?.voiceId && voice.voiceId !== "default" ? voice.voiceId : "female-shaonv";
  const body = JSON.stringify({
    model: voice?.model || model,
    text,
    stream: false,
    voice_setting: {
      voice_id: voiceId,
      speed: voice?.speed ?? 1,
      vol: voice?.volume ?? 1,
      pitch: voice?.pitch ?? 0,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: "pcm",
      channel: 1,
    },
  });

  const res = await fetch("https://api.minimaxi.com/v1/t2a_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body,
    signal,
  });

  const buf = Buffer.from(await res.arrayBuffer());
  const r = JSON.parse(buf.toString());
  if (r?.base_resp?.status_code && r.base_resp.status_code !== 0) {
    throw new Error(`MiniMax API error: ${JSON.stringify(r.base_resp).slice(0, 200)}`);
  }
  const hexAudio = r?.data?.audio;
  if (!hexAudio) throw new Error("MiniMax TTS no audio field");
  return Buffer.from(hexAudio, "hex");
}

export class VeynorSkill {
  private agent: Agent;
  private _roundtable: RoundtableRuntime | null = null;
  private _roundtableObjective: ((text: string, participantId: string) => MeetingObjective) | null = null;
  private transport: DiscordVoiceTransport | null = null;
  private session: DefaultAudioSession | null = null;
  private _running = false;
  private _currentTurn: VoiceTurnContext | null = null;
  private _transportId: string;
  private _groqApiKey: string | null = null;
  private _minimaxApiKey: string | null = null;
  private _turnNo = 0;
  // Echo-suppression state. The bot's own TTS audio can leak back
  // (through the user's speakers, the channel, or Discord's internal
  // routing). We track speaking state and post-TTS cooldown so the
  // bot doesn't STT its own reply.
  private readonly _bargeIn: BargeInController;
  // RMS threshold (out of 32768) for the loudness gate. Audio below
  // this is treated as background noise / quiet media and dropped.
  // Default 80 ≈ -52 dBFS. Override via `loudnessGate` constructor opt.
  // VAD gate. When true, run energy + ZCR analysis on the utterance
  // before STT. When false, skip VAD and rely only on the other gates
  // (loudness, duration, backchannel, Whisper confidence).
  private _vadEnabled = true;
  // Drop the utterance if Whisper reports no_speech_prob > this.
  // Range 0-1. Default 0.6 = drop if Whisper thinks it's >60% not speech.
  private _noSpeechThreshold = 0.6;
  // MiniMax TTS model. Default keeps the previous hardcoded value;
  // callers can override via the constructor option.
  private _minimaxModel: string = "speech-2.8-hd";
  // Reference count for "any TTS is currently being played". Replaces
  // the boolean _isSpeaking so two overlapping TTS streams (e.g. voice
  // turn TTS being pre-empted by an @bot reply TTS) don't race on the
  // flag — the flag stays true until the LAST stream finishes.
  // In-flight @bot text reply. A new mention aborts the previous
  // controller so the old LLM subprocess is killed mid-flight. Voice
  // turns use their own AbortController via _startTurn().
  private _textAbortController: AbortController | null = null;
  // Track in-flight async tasks (_onUtterance, _audioLoop, etc.) so
  // leave()/disconnect() can wait for them to settle before tearing
  // down the session. Without this, network calls and audio playback
  // started inside an utterance can outlive a leave() call.
  private readonly _activeTasks = new Set<Promise<unknown>>();

  static async create(agent: Agent, opts?: VeynorSkillOptions): Promise<VeynorSkill> {
    if (opts?.roundtable?.localRegistry && opts.roundtable.agents?.length) {
      console.warn("[VeynorSkill] roundtable.agents provided; preferring agents over roundtable.localRegistry.");
    }
    if (!opts?.roundtable?.localRegistry || opts.roundtable.agents?.length) {
      return new VeynorSkill(agent, opts);
    }

    const agents = await loadLocalRoundtableAgents(opts.roundtable.localRegistry);
    return new VeynorSkill(agent, {
      ...opts,
      roundtable: {
        ...opts.roundtable,
        agents,
      },
    });
  }

  constructor(agent: Agent, opts?: VeynorSkillOptions) {
    this.agent = agent;
    this._bargeIn = new BargeInController({
      loudnessGate: opts?.loudnessGate,
      postTtsCooldownMs: opts?.postTtsCooldownMs,
    });
    this._transportId = opts?.transportId ?? "discord";
    if (opts?.groqApiKey) this._groqApiKey = opts.groqApiKey;
    if (opts?.minimaxApiKey) this._minimaxApiKey = opts.minimaxApiKey;
    if (opts?.vadEnabled !== undefined) this._vadEnabled = opts.vadEnabled;
    if (opts?.noSpeechThreshold !== undefined) this._noSpeechThreshold = opts.noSpeechThreshold;
    if (opts?.minimaxModel) this._minimaxModel = opts.minimaxModel;
    if (opts?.roundtable) {
      if (!opts.roundtable.agents?.length) {
        throw new Error("VeynorSkill roundtable requires agents. Use VeynorSkill.create() for localRegistry loading.");
      }
      this._roundtableObjective = opts.roundtable.objective ?? defaultRoundtableObjective;
      this._roundtable = new RoundtableRuntime({
        agents: opts.roundtable.agents,
        maxInitialSpeakers: opts.roundtable.maxInitialSpeakers,
        maxRebuttalRounds: opts.roundtable.maxRebuttalRounds,
        maxTotalMs: opts.roundtable.maxTotalMs,
        hooks: {
          onSpeech: async (speech) => {
            if (!this._currentTurn || this._currentTurn.signal.aborted) return;
            console.log(`[T#${this._currentTurn.id}] ROUNDTABLE ${speech.agentId}: "${speech.text.slice(0, 80)}"`);
            await this._speak(speech.text, this._currentTurn, {
              model: speech.agent.ttsModel || undefined,
              voiceId: speech.agent.voiceId,
              speed: speech.agent.ttsSpeed,
              volume: speech.agent.ttsVolume,
              pitch: speech.agent.ttsPitch,
            });
          },
        },
      });
    }
  }

  async connect(config: VoiceConnectConfig): Promise<void> {
    this.transport = new DiscordVoiceTransport({
      token: config.token,
      guildId: config.guildId,
      channelName: config.channelName,
    });
    await this.transport.connect();

    this.transport.discordClient.on("messageCreate", (message: Message) => {
      if (!this._running) return;
      if (message.author.bot) return;
      if (!message.mentions.users.has(this.transport!.discordClient.user!.id)) return;
      this._trackTask(
        this._handleTextMessage(message).catch((e) => {
          console.error("[Veynor] @bot error:", e);
        })
      );
    });
  }

  async join(): Promise<void> {
    if (!this.transport) throw new Error("call connect() first");
    // Re-entry is a caller bug: it would create a second session, a
    // second audio loop, and a second utterance handler, all racing
    // for the same transport. Throw loudly rather than fail silently.
    if (this._running || this.session) {
      throw new Error("VeynorSkill: already joined — call leave() first");
    }
    this.session = new DefaultAudioSession({ silenceMs: 1500 });
    this._running = true;

    this.session.onUtterance((utterance) => {
      this._trackTask(
        this._onUtterance(utterance).catch((e) => {
          console.error("[Veynor] utterance error:", e);
        })
      );
    });

    this._trackTask(
      this._audioLoop().catch((err) => {
        if (this._running) console.error("[Veynor] audio loop error:", err);
      })
    );
  }

  async leave(): Promise<void> {
    this._running = false;
    this._textAbortController?.abort();
    this._textAbortController = null;
    this._cancelTurn();
    this._bargeIn.resetSpeaking();
    this.transport?.stopOutput();
    this.transport?.stopInput();
    // Wait for in-flight _onUtterance / _audioLoop tasks to settle
    // before we flush and release the session.
    await Promise.allSettled([...this._activeTasks]);
    await this.session?.flush();
    this.session = null;
  }

  async disconnect(): Promise<void> {
    this._running = false;
    this._textAbortController?.abort();
    this._textAbortController = null;
    this._cancelTurn();
    this._bargeIn.resetSpeaking();
    const transport = this.transport;
    transport?.stopOutput();
    transport?.stopInput();
    await Promise.allSettled([...this._activeTasks]);
    await this.session?.flush();
    this.session = null;
    if (transport) {
      await transport.disconnect();
      if (this.transport === transport) this.transport = null;
    }
    console.log("[Veynor] Disconnected, bot left the server");
  }

  private _trackTask(promise: Promise<unknown>): void {
    this._activeTasks.add(promise);
    promise.finally(() => {
      this._activeTasks.delete(promise);
    });
  }

  private _cancelTurn(): void {
    const turn = this._currentTurn;
    this._currentTurn = null;
    if (turn && turn.state !== TurnState.COMPLETED && turn.state !== TurnState.FAILED) {
      turn.interrupt();
    }
  }

  private async _audioLoop(): Promise<void> {
    if (!this.transport) return;
    try {
      for await (const frame of this.transport.input()) {
        if (!this._running) break;

        const decision = this._bargeIn.evaluateFrame(frame.data);

        // Drop frames classified as echo, cooldown, or too quiet by the barge-in gate.
        if (decision.action === "drop") {
          if (decision.reason === "post-tts-cooldown") {
            if (Math.random() < 0.05) {
              console.log(`[Veynor] drop frame: post-TTS cooldown (${decision.sinceTtsMs}ms < ${this._bargeIn.cooldownMs}ms)`);
            }
            continue;
          }
          console.log(`[Veynor] drop frame: ${decision.reason}, rms=${decision.rms.toFixed(0)} < ${this._bargeIn.loudnessGate}`);
          continue;
        }

        // Loud user audio while the bot is speaking is treated as an interrupt.
        if (decision.action === "barge-in") {
          console.log(`[Veynor] BARGE-IN rms=${decision.rms.toFixed(0)} >= ${this._bargeIn.loudnessGate}`);
          this._cancelTurn();
        }

        if (!this.session) {
          console.log(`[Veynor] drop frame: session is null (not joined?)`);
          continue;
        }

        this.session.push(frame);
      }
    } catch (err) {
      if (this._running) throw err;
    }
  }

  private async _onUtterance(utterance: Utterance): Promise<void> {
    if (!this._running) return;

    const turn = this._startTurn();
    turn.state = TurnState.LISTENING;

    const chunks: Buffer[] = [];
    if (utterance.audio) {
      for await (const frame of utterance.audio) {
        chunks.push(frame.data);
      }
    }
    const pcm = Buffer.concat(chunks);
    const participantId = `${this._transportId}:${utterance.speakerId}`;
    console.log(`[T#${turn.id}] ${participantId} PCM ${pcm.length}b`);
    if (turn.signal.aborted) return;

    // ── Pollution filter #1: minimum audio duration ─────────────
    // Discord PCM is 48kHz, 2 channels, 16-bit → 192000 bytes/sec.
    // A real utterance is usually at least ~0.5 second. Anything
    // shorter is almost always a backchannel ("嗯", "啊", a cough,
    // mic pop). Calling STT + LLM on it makes the agent hallucinate
    // a response to nothing.
    const minPcmBytes = 192000 * 0.5; // 0.5 second
    if (pcm.length < minPcmBytes) {
      console.log(
        `[T#${turn.id}] SKIP audio-too-short (${pcm.length}b < ${minPcmBytes}b, ~${(pcm.length / 192000).toFixed(2)}s) — likely backchannel / mic pop`
      );
      turn.state = TurnState.COMPLETED;
      return;
    }

    turn.state = TurnState.TRANSCRIBING;

    // ── Pollution filter #2: VAD (energy + ZCR) ──────────────────
    // Cheap local check: does the PCM look like real human speech?
    // Looks at per-frame RMS dynamic range and zero-crossing rate to
    // reject silence, steady noise, music, and pure tones — all of
    // which Whisper will happily hallucinate text for.
    if (this._vadEnabled) {
      const vad = analyzeSpeechActivity(pcm);
      if (!vad.isSpeech) {
        console.log(
          `[T#${turn.id}] SKIP VAD (${vad.reason}) ` +
            `peak=${vad.peakRms.toFixed(0)} floor=${vad.floorRms.toFixed(0)} ` +
            `avgRms=${vad.avgRms.toFixed(0)} avgZcr=${vad.avgZcr.toFixed(2)}`
        );
        turn.state = TurnState.COMPLETED;
        return;
      }
      console.log(
        `[T#${turn.id}] VAD OK ` +
          `(peak=${vad.peakRms.toFixed(0)} floor=${vad.floorRms.toFixed(0)} ` +
          `avgRms=${vad.avgRms.toFixed(0)} avgZcr=${vad.avgZcr.toFixed(2)})`
      );
    }

    const { text, noSpeechProb } = await transcribe(pcm, this._groqApiKey);

    // ── Pollution filter #3: Whisper's own no_speech confidence ───
    // Whisper's verbose_json response includes a per-segment
    // no_speech_prob (0-1). If it's high, Whisper itself thinks the
    // audio wasn't speech — trust it and skip the turn.
    if (noSpeechProb > this._noSpeechThreshold) {
      console.log(
        `[T#${turn.id}] SKIP whisper-no-speech (prob=${noSpeechProb.toFixed(2)} > ${this._noSpeechThreshold})`
      );
      turn.state = TurnState.COMPLETED;
      return;
    }

    turn.userText = text;
    if (!text || turn.signal.aborted) {
      if (!turn.signal.aborted) turn.state = TurnState.FAILED;
      return;
    }
    console.log(`[T#${turn.id}] STT "${text}"`);

    // ── Pollution filter #4: backchannel whitelist ──────────────
    // Pure backchannels ("嗯", "ok", "uh-huh") don't carry a question
    // and will cause the LLM to invent one. If the STT result is just
    // a backchannel, skip the LLM call entirely.
    if (isBackchannel(text)) {
      console.log(`[T#${turn.id}] SKIP backchannel "${text}" — not calling LLM`);
      turn.state = TurnState.COMPLETED;
      return;
    }

    turn.state = TurnState.THINKING;
    try {
      if (this._roundtable && this._roundtableObjective) {
        const objective = this._roundtableObjective(text, participantId);
        const result = await this._roundtable.runTurn({
          objective,
          userText: text,
          participantId,
          signal: turn.signal,
        });
        if (turn.signal.aborted) {
          console.log(`[T#${turn.id}] INTERRUPTED (roundtable)`);
          return;
        }
        turn.assistantText = result.decision.finalAnswer;
        turn.state = TurnState.COMPLETED;
        console.log(`[T#${turn.id}] ROUNDTABLE COMPLETED (${result.speeches.length} speeches)`);
        return;
      }

      const reply = await this.agent.chat(text, participantId, turn.signal);
      if (turn.signal.aborted) {
        console.log(`[T#${turn.id}] INTERRUPTED (thinking)`);
        return;
      }
      turn.assistantText = reply;
      if (!reply) {
        console.log(`[T#${turn.id}] EMPTY reply, skipping TTS`);
        turn.state = TurnState.FAILED;
        return;
      }
      console.log(`[T#${turn.id}] REPLY "${reply}"`);

      turn.state = TurnState.SPEAKING;
      await this._speak(reply, turn);

      if (turn.signal.aborted) {
        console.log(`[T#${turn.id}] INTERRUPTED (speaking)`);
      } else {
        turn.state = TurnState.COMPLETED;
        console.log(`[T#${turn.id}] COMPLETED`);
      }
    } catch (e) {
      if (!turn.signal.aborted) {
        turn.state = TurnState.FAILED;
        console.error("[Veynor] agent error:", e);
      }
    }
  }

  private _startTurn(): VoiceTurnContext {
    this._cancelTurn();
    this._turnNo++;
    const id = this._turnNo;
    const controller = new AbortController();
    const self = this;

    const turn: VoiceTurnContext = {
      id,
      signal: controller.signal,
      state: TurnState.CREATED,
      userText: "",
      assistantText: "",
      interrupt() {
        if (controller.signal.aborted) return;
        if (turn.state === TurnState.COMPLETED || turn.state === TurnState.FAILED) return;
        turn.state = TurnState.INTERRUPTED;
        controller.abort();
        if (self._currentTurn === turn) {
          self._currentTurn = null;
        }
        self.transport?.stopOutput();
      },
    };

    this._currentTurn = turn;
    console.log(`[T#${id}] ${TurnState.CREATED}`);
    return turn;
  }

  private async _handleTextMessage(message: Message): Promise<void> {
    if (!this.transport || !this._running) return;
    const text = message.content.replace(/<@!?\d+>/g, "").trim();
    if (!text) return;

    // Abort any previous @bot reply that's still in flight (LLM call
    // or TTS playback) so the old subprocess is killed and we don't
    // speak two replies on top of each other.
    this._textAbortController?.abort();
    const controller = new AbortController();
    this._textAbortController = controller;
    const participantId = `${this._transportId}:${message.author.id}`;
    const username = message.author.username;
    console.log(`\uD83D\uDCAC @bot ${username}: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);

    const channel = message.channel as {
      sendTyping?: () => Promise<unknown>;
      send?: (content: string) => Promise<{ delete?: () => Promise<unknown> } | undefined>;
    };
    console.log(
      `[Veynor] @bot status caps: sendTyping=${typeof channel.sendTyping === "function"}, send=${typeof channel.send === "function"}`
    );

    // PRIMARY status display: post a temporary "🤔 思考中..." message
    // in the channel. This uses the same SEND_MESSAGES permission the
    // reply needs, so it's guaranteed to work as long as the reply
    // itself can land. Typing indicator and reaction are secondary
    // (the reaction needs ADD_REACTIONS which the bot may not have).
    // Deleted once the reply is sent.
    let thinkingMsg: { delete?: () => Promise<unknown> } | undefined;
    try {
      if (typeof channel.send === "function") {
        thinkingMsg = await channel.send("🤔 思考中...");
        console.log("[Veynor] @bot status msg sent");
      }
    } catch (e) {
      console.error("[Veynor] @bot status msg failed:", (e as Error).message);
    }

    // SECONDARY: "Bot is typing..." indicator, refreshed every 8s
    // because Discord auto-expires it after ~10s. Silently fires.
    let typingTimer: ReturnType<typeof setInterval> | null = null;
    if (typeof channel.sendTyping === "function") {
      const tick = () => {
        channel.sendTyping!().catch((err: Error) => {
          console.error("[Veynor] @bot sendTyping failed:", err.message);
        });
      };
      tick();
      typingTimer = setInterval(tick, 8000);
    }

    // TERTIARY: 🤔 reaction on the user's message. Requires
    // ADD_REACTIONS permission; silent no-op without it.
    let thinkingReaction = false;
    try {
      const reactFn = (message as Message & { react?: (emoji: string) => Promise<unknown> }).react;
      if (typeof reactFn === "function") {
        await reactFn.call(message, "🤔");
        thinkingReaction = true;
        console.log("[Veynor] @bot thinking reaction added");
      }
    } catch (e) {
      console.error("[Veynor] @bot react failed:", (e as Error).message);
    }

    try {
      let reply: string;
      try {
        reply = await this.agent.chat(text, participantId, controller.signal);
      } catch (e) {
        if (controller.signal.aborted) return;
        throw e;
      }
      if (controller.signal.aborted || !reply) return;

      console.log(`\uD83D\uDCAC @bot reply: "${reply.slice(0, 60)}${reply.length > 60 ? "..." : ""}"`);

      try {
        const ch = message.channel as { send?: (content: string) => Promise<unknown> };
        await sendDiscordMessage(ch, reply);
      } catch (e) {
        console.error("[Veynor] @bot send failed:", (e as Error).message ?? String(e));
      }

      if (controller.signal.aborted || !this.transport) return;

      const pcm32k = await minimaxTTS(reply, this._minimaxApiKey, this._minimaxModel, undefined, controller.signal);
      if (controller.signal.aborted) return;

      this._bargeIn.enterSpeaking();
      try {
        await this.transport.output(
          (async function* () {
            for (const f of pcm32kToFrames48k(pcm32k)) yield f;
          })()
        );
      } finally {
        this._bargeIn.exitSpeaking(controller.signal.aborted);
      }
    } finally {
      if (typingTimer) clearInterval(typingTimer);
      if (thinkingReaction) {
        try {
          const me = this.transport?.discordClient.user;
          const reaction = message.reactions.cache.find((r) => r.emoji.name === "🤔");
          if (reaction && me) {
            await reaction.users.remove(me.id);
          }
        } catch {}
      }
      if (thinkingMsg?.delete) {
        try { await thinkingMsg.delete(); } catch {}
      }
    }
  }

  private async _speak(text: string, turn: VoiceTurnContext, voice?: TtsVoiceProfile): Promise<void> {
    if (!this.transport || !this._running) return;
    if (turn.signal.aborted) return;

    const preview = text.length > 40 ? text.slice(0, 40) + "..." : text;
    console.log(`[T#${turn.id}] TTS "${preview}"`);
    const pcm32k = await minimaxTTS(text, this._minimaxApiKey, this._minimaxModel, voice, turn.signal);
    if (turn.signal.aborted) return;
    console.log(`[T#${turn.id}] PCM ${pcm32k.length}b, playing`);

    // Mark speaking so _audioLoop drops any incoming frames (echo
    // suppression). Reset the marker only after output() resolves.
    this._bargeIn.enterSpeaking();
    try {
      await this.transport.output(
        (async function* () {
          for (const f of pcm32kToFrames48k(pcm32k)) yield f;
        })()
      );
    } finally {
      this._bargeIn.exitSpeaking(turn.signal.aborted);
    }
  }
}

function defaultRoundtableObjective(text: string, _participantId: string): MeetingObjective {
  return {
    kind: "answer_user",
    prompt: text,
    requiredOutput: "A concise multi-agent answer for voice playback.",
  };
}

/**
 * Compute the zero-crossing rate (ZCR) of a 16-bit signed PCM buffer.
 * ZCR is the fraction of samples that change sign from the previous
 * sample. It's a cheap proxy for "is this broadband noise or speech":
 *   - silence:   ZCR ≈ 0
 *   - white noise: ZCR ≈ 0.5
 *   - music:     ZCR ≈ 0.2-0.3
 *   - speech:    ZCR ≈ 0.05-0.2 (vowels are band-limited, fricatives higher)
 */
function computeZcr(pcm: Buffer): number {
  if (pcm.length < 4) return 0;
  let crossings = 0;
  let comparisons = 0;
  for (let i = 2; i < pcm.length; i += 2) {
    const prev = pcm.readInt16LE(i - 2);
    const curr = pcm.readInt16LE(i);
    if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) {
      crossings++;
    }
    comparisons++;
  }
  return comparisons > 0 ? crossings / comparisons : 0;
}

/**
 * Voice activity detection. Splits the PCM into 20ms frames, computes
 * RMS and ZCR per frame, then applies heuristics to decide whether the
 * utterance is real human speech (vs. silence, steady noise, music,
 * backchannels, etc.).
 *
 * Returns:
 *   isSpeech        — true if the utterance looks like speech
 *   reason          — why it was rejected (if !isSpeech)
 *   peakRms / floor — loudest and quietest 20ms frames
 *   avgRms / avgZcr — averages over all frames
 */
function analyzeSpeechActivity(
  pcm: Buffer,
  sampleRate = 48000,
  channels = 2
): {
  isSpeech: boolean;
  reason: string | null;
  peakRms: number;
  floorRms: number;
  avgRms: number;
  avgZcr: number;
} {
  const frameMs = 20;
  const frameSize = (sampleRate * channels * 2 * frameMs) / 1000; // 3840 bytes @ 48k stereo

  if (pcm.length < frameSize * 3) {
    return { isSpeech: false, reason: "too-short", peakRms: 0, floorRms: 0, avgRms: 0, avgZcr: 0 };
  }

  const rmsValues: number[] = [];
  const zcrValues: number[] = [];

  for (let offset = 0; offset + frameSize <= pcm.length; offset += frameSize) {
    const frame = pcm.subarray(offset, offset + frameSize);
    rmsValues.push(computeRms(frame));
    zcrValues.push(computeZcr(frame));
  }

  const peakRms = Math.max(...rmsValues);
  const floorRms = Math.min(...rmsValues);
  const avgRms = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
  const avgZcr = zcrValues.reduce((a, b) => a + b, 0) / zcrValues.length;

  // ── Decision heuristics ──────────────────────────────────────
  // Speech has a clear dynamic range (loud peaks, quiet valleys).
  // If the signal is uniformly loud (no dynamic range) it's almost
  // certainly steady noise, not human speech.
  if (peakRms < 150) {
    return { isSpeech: false, reason: "peak-too-quiet", peakRms, floorRms, avgRms, avgZcr };
  }
  if (floorRms > 0 && peakRms / Math.max(floorRms, 1) < 2.5) {
    return {
      isSpeech: false,
      reason: "no-dynamic-range",
      peakRms,
      floorRms,
      avgRms,
      avgZcr,
    };
  }
  // ZCR as a *secondary* signal: too low = pure tone, too high = pure
  // noise. Widened band (0.005-0.6) so fricatives and noisy rooms
  // still pass through. Dynamic-range check above is the real gate.
  if (avgZcr > 0.6) {
    return { isSpeech: false, reason: "zcr-too-high", peakRms, floorRms, avgRms, avgZcr };
  }
  if (avgZcr < 0.005 && peakRms > 0) {
    return { isSpeech: false, reason: "zcr-too-low", peakRms, floorRms, avgRms, avgZcr };
  }

  return { isSpeech: true, reason: null, peakRms, floorRms, avgRms, avgZcr };
}
