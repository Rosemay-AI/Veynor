export type BargeInDecision =
  | {
      action: "drop";
      reason: "bot-speaking-echo" | "post-tts-cooldown" | "too-quiet";
      rms: number;
      sinceTtsMs?: number;
    }
  | {
      action: "barge-in";
      rms: number;
    }
  | {
      action: "accept";
      rms: number;
    };

export type BargeInControllerOptions = {
  loudnessGate?: number;
  postTtsCooldownMs?: number;
};

export class BargeInController {
  private speakingCount = 0;
  private ttsEndTime = 0;
  private minRmsThreshold = 30;
  private postTtsCooldownMs = 1500;

  constructor(options?: BargeInControllerOptions) {
    if (options?.loudnessGate !== undefined) {
      this.minRmsThreshold = options.loudnessGate;
    }
    if (options?.postTtsCooldownMs !== undefined) {
      this.postTtsCooldownMs = options.postTtsCooldownMs;
    }
  }

  updateOptions(options: BargeInControllerOptions): void {
    if (options.loudnessGate !== undefined) {
      this.minRmsThreshold = options.loudnessGate;
    }
    if (options.postTtsCooldownMs !== undefined) {
      this.postTtsCooldownMs = options.postTtsCooldownMs;
    }
  }

  enterSpeaking(): void {
    this.speakingCount++;
  }

  exitSpeaking(aborted: boolean): void {
    if (this.speakingCount > 0) this.speakingCount--;
    if (this.speakingCount === 0 && !aborted) {
      this.ttsEndTime = Date.now();
    }
  }

  resetSpeaking(): void {
    this.speakingCount = 0;
    this.ttsEndTime = 0;
  }

  evaluateFrame(pcm: Buffer, now = Date.now()): BargeInDecision {
    if (pcm.length < 2) return { action: "drop", reason: "too-quiet", rms: 0 };
    const rms = computeRms(pcm);

    if (this.speakingCount > 0) {
      if (rms < this.minRmsThreshold) {
        return { action: "drop", reason: "bot-speaking-echo", rms };
      }
      return { action: "barge-in", rms };
    }

    const sinceTtsMs = now - this.ttsEndTime;
    if (sinceTtsMs < this.postTtsCooldownMs) {
      return { action: "drop", reason: "post-tts-cooldown", rms, sinceTtsMs };
    }

    if (rms < this.minRmsThreshold) {
      return { action: "drop", reason: "too-quiet", rms };
    }

    return { action: "accept", rms };
  }

  get loudnessGate(): number {
    return this.minRmsThreshold;
  }

  get cooldownMs(): number {
    return this.postTtsCooldownMs;
  }
}

export function computeRms(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  let sum = 0;
  // Treat interleaved stereo PCM as one sample stream; loudnessGate is calibrated against Discord 48k stereo frames.
  const samples = pcm.length >> 1;
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}
