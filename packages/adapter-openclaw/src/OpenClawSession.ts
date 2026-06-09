import type { OpenClawRuntime, OpenClawRuntimeSession } from "./OpenClawRuntime.js";
import { OpenClawTurn } from "./OpenClawTurn.js";

export abstract class OpenClawSession {
  private runtime: OpenClawRuntime;
  private runtimeSession: OpenClawRuntimeSession | null = null;
  private turnCount = 0;
  private currentTurn: OpenClawTurn | null = null;
  private started = false;

  constructor(runtime: OpenClawRuntime) {
    this.runtime = runtime;
  }

  async start(): Promise<void> {
    // Idempotent: a second start() call returns immediately instead of
    // leaking the previous runtimeSession (whose close() would never
    // otherwise be called).
    if (this.started) return;
    this.runtimeSession = this.runtime.createSession();
    this.started = true;
  }

  async close(): Promise<void> {
    if (this.currentTurn) {
      this.currentTurn.close();
      this.currentTurn = null;
    }
    if (this.runtimeSession) {
      this.runtimeSession.close();
      this.runtimeSession = null;
    }
  }

  startTurn(): OpenClawTurn {
    if (this.currentTurn) {
      this.currentTurn.interrupt();
      this.currentTurn = null;
    }
    if (!this.runtimeSession) {
      this.runtimeSession = this.runtime.createSession();
    }
    const turn = new OpenClawTurn(String(++this.turnCount), this.runtimeSession);
    this.currentTurn = turn;
    this.runtimeSession.startTurn();
    return turn;
  }

  getActiveTurn(): OpenClawTurn | null {
    return this.currentTurn;
  }

  cancelTurn(): void {
    if (this.currentTurn) {
      this.currentTurn.interrupt();
      this.currentTurn = null;
    }
  }

  getRuntimeSession(): OpenClawRuntimeSession | null {
    return this.runtimeSession;
  }
}
