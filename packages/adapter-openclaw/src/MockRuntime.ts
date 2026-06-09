import type { AudioFrame } from "@veynor/core";
import type { OpenClawRuntime, OpenClawRuntimeSession } from "./OpenClawRuntime.js";

function generateSilenceFrame(sampleRate: number, channels: number, ms: number): AudioFrame {
  const sampleCount = Math.floor(sampleRate * ms / 1000);
  const byteLen = sampleCount * channels * 2;
  return { sampleRate, channels, bitDepth: 16, timestamp: Date.now(), data: Buffer.alloc(byteLen) };
}

class MockSession implements OpenClawRuntimeSession {
  private audioListeners: Array<(frame: AudioFrame) => void> = [];
  private transcriptListeners: Array<(text: string) => void> = [];

  onAudio(cb: (frame: AudioFrame) => void): () => void {
    this.audioListeners.push(cb);
    return () => {
      const i = this.audioListeners.indexOf(cb);
      if (i >= 0) this.audioListeners.splice(i, 1);
    };
  }

  onTranscript(cb: (text: string) => void): () => void {
    this.transcriptListeners.push(cb);
    return () => {
      const i = this.transcriptListeners.indexOf(cb);
      if (i >= 0) this.transcriptListeners.splice(i, 1);
    };
  }

  pushAudio(_frame: AudioFrame): void {
  }

  startTurn(): void {
  }

  endTurn(): void {
    for (const cb of this.transcriptListeners) {
      cb("你好！我是模拟的 OpenClaw Agent。");
    }

    const sampleRate = 48000;
    const channels = 2;
    for (let i = 0; i < 80; i++) {
      for (const cb of this.audioListeners) {
        cb(generateSilenceFrame(sampleRate, channels, 20));
      }
    }
  }

  interrupt(): void {
  }

  close(): void {
    this.audioListeners = [];
    this.transcriptListeners = [];
  }
}

export class MockOpenClawRuntime implements OpenClawRuntime {
  createSession(): OpenClawRuntimeSession {
    return new MockSession();
  }
}
