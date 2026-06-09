import { DefaultAudioSession, type AudioFrame } from "@veynor/core";
import {
  registerSkill,
  SkillRuntime,
  skills,
  pipe,
} from "@veynor/skill-sdk";
import {
  HermesAgent,
  createBridgeSkill,
} from "@veynor/agent";
import { HermesTTS } from "./HermesTTS.js";

function makeAudioFrame(speakerId: string, sampleRate = 48000, channels = 2, ms = 20): AudioFrame {
  const samples = Math.floor((sampleRate * ms) / 1000) * channels;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin(i * 0.01) * 1000 + Math.random() * 200), i * 2);
  }
  return { sampleRate, channels, bitDepth: 16, timestamp: Date.now(), speakerId, data: buf };
}

async function silence(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type PhaseResult = { name: string; pass: boolean; detail: string };
const RESULTS: PhaseResult[] = [];

type Check = () => string | boolean | Promise<string | boolean>;

async function group(header: string, checks: Check[]): Promise<boolean> {
  console.log(`\n  ${header}`);
  let allPass = true;
  for (const check of checks) {
    const result = await check();
    if (result === true) {
      console.log("    ok");
    } else {
      console.log(`    FAIL: ${result}`);
      allPass = false;
    }
  }
  return allPass;
}

function phase(name: string): void {
  console.log(`\n--- ${name} ---`);
}

function report(): void {
  console.log("\n========================================");
  console.log("  V1 STABILITY TEST SUITE RESULTS");
  console.log("========================================");
  for (const r of RESULTS) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"} ${r.name}${r.detail ? " -- " + r.detail : ""}`);
  }
  const passed = RESULTS.filter((r) => r.pass).length;
  const failed = RESULTS.length - passed;
  console.log(`\n  ${passed}/${RESULTS.length} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("  STATUS: FAIL");
    process.exit(1);
  }
  console.log("  STATUS: PASS\n");
}

async function runTurn(
  session: DefaultAudioSession,
  runtime: SkillRuntime,
  speakerId: string,
  frameCount: number,
): Promise<{ audioFrames: number; outputFrames: number; outputBytes: number }> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const done = setTimeout(() => {
      if (!resolved) { resolved = true; reject(new Error("utterance handler timeout")); }
    }, 5000);

    session.onUtterance(async (utterance) => {
      if (resolved) return;
      if (utterance.speakerId !== speakerId) return;

      try {
        const raw: AudioFrame[] = [];
        const src = utterance.audio;
        if (src) for await (const f of src) raw.push(f);

        const playable = {
          speakerId: utterance.speakerId,
          timestamp: utterance.timestamp,
          audio: (async function* () { for (const f of raw) yield f; })(),
        };

        const output: AudioFrame[] = [];
        for await (const frame of runtime.processUtterance(playable)) {
          output.push(frame);
        }

        clearTimeout(done);
        resolved = true;
        resolve({
          audioFrames: raw.length,
          outputFrames: output.length,
          outputBytes: output.reduce((s, f) => s + f.data.length, 0),
        });
      } catch (e) {
        if (!resolved) { resolved = true; reject(e instanceof Error ? e : new Error(String(e))); }
      }
    });

    for (let j = 0; j < frameCount; j++) {
      session.push(makeAudioFrame(speakerId));
    }
  });
}

async function main() {
  registerSkill(new HermesTTS());

  // ===== Phase A: Single Session -- 10 consecutive turns =====
  {
    phase("Phase A: Single Session -- 10 consecutive turns");

    const hermes = new HermesAgent({
      id: "hermes-a",
      processText: async (text) => ({ text: `A: ${text}` }),
    });
    const adapter = createBridgeSkill(hermes.toSkillOptions());
    const tts = new HermesTTS();
    registerSkill(adapter);
    registerSkill(pipe([adapter, tts]));
    const pipelineId = `pipeline-${adapter.id}-${tts.id}`;
    const session = new DefaultAudioSession({ silenceMs: 200 });
    const runtime = new SkillRuntime(skills, pipelineId);

    const turnCount = 10;
    const turnResults: number[] = [];

    const overall = await group(`Run ${turnCount} turns on session [single-user-10]`, [
      async () => {
        for (let i = 0; i < turnCount; i++) {
          const r = await runTurn(session, runtime, "single-user-10", 12 + i * 2);
          turnResults.push(r.outputFrames > 0 ? 1 : 0);
        }
        return true;
      },
      () => {
        const deadTurns = turnResults.filter((r) => r === 0).length;
        return deadTurns === 0 ? true : `${deadTurns}/${turnCount} dead turns`;
      },
      () => turnResults.every((r) => r === 1) ? true : "not all turns had output",
      () => turnResults.length === turnCount ? true : `expected ${turnCount} turns, got ${turnResults.length}`,
    ]);

    RESULTS.push({
      name: "Phase A -- Single Session Stability",
      pass: overall,
      detail: `${turnResults.filter((r) => r === 1).length}/${turnCount} turns alive`,
    });
  }

  // ===== Phase B: Barge-in =====
  {
    phase("Phase B: Barge-in -- interrupt injection");

    let outputFlowed = false;

    const hermes = new HermesAgent({
      id: "hermes-b",
      processText: async (text) => {
        await silence(100);
        return { text: `Slow: ${text}` };
      },
    });

    const adapter = createBridgeSkill(hermes.toSkillOptions());
    const tts = new HermesTTS();
    registerSkill(adapter);
    const pipeline = pipe([adapter, tts]);
    registerSkill(pipeline);

    const session = new DefaultAudioSession({ silenceMs: 150 });
    const runtime = new SkillRuntime(skills, pipeline.id);

    const overall = await group("Verify abort path", [
      async () => {
        for (let j = 0; j < 10; j++) {
          session.push(makeAudioFrame("barge-user"));
        }

        const done = new Promise<void>((resolve) => {
          session.onUtterance(async (utterance) => {
            if (utterance.speakerId !== "barge-user") return;
            try {
              const raw: AudioFrame[] = [];
              const src = utterance.audio;
              if (src) for await (const f of src) raw.push(f);

              const playable = {
                speakerId: utterance.speakerId,
                timestamp: utterance.timestamp,
                audio: (async function* () { for (const f of raw) yield f; })(),
              };

              for await (const _frame of runtime.processUtterance(playable)) {
                outputFlowed = true;
              }
              resolve();
            } catch (e) {
              resolve();
            }
          });
        });

        await silence(100);
        session.push(makeAudioFrame("interrupter"));
        await silence(200);
        await done;
        return true;
      },
      () => outputFlowed ? true : "pipeline produced no output after concurrent input",
    ]);

    RESULTS.push({
      name: "Phase B -- Barge-in",
      pass: overall,
      detail: outputFlowed ? "pipeline survived concurrent injection" : "failed",
    });
  }

  // ===== Phase C: Multi-session isolation (3 concurrent) =====
  {
    phase("Phase C: Multi-session -- 3 concurrent users");

    const sessions = {
      alice: new DefaultAudioSession({ silenceMs: 150 }),
      bob: new DefaultAudioSession({ silenceMs: 150 }),
      carol: new DefaultAudioSession({ silenceMs: 150 }),
    };

    const hermesA = new HermesAgent({ id: "hermes-c-alice", processText: async (text) => ({ text: `Alice: ${text}` }) });
    const hermesB = new HermesAgent({ id: "hermes-c-bob", processText: async (text) => ({ text: `Bob: ${text}` }) });
    const hermesC = new HermesAgent({ id: "hermes-c-carol", processText: async (text) => ({ text: `Carol: ${text}` }) });

    const tts = new HermesTTS();
    const adapterA = createBridgeSkill(hermesA.toSkillOptions());
    const adapterB = createBridgeSkill(hermesB.toSkillOptions());
    const adapterC = createBridgeSkill(hermesC.toSkillOptions());

    registerSkill(adapterA);
    registerSkill(adapterB);
    registerSkill(adapterC);
    registerSkill(pipe([adapterA, tts]));
    registerSkill(pipe([adapterB, tts]));
    registerSkill(pipe([adapterC, tts]));

    const runtimes = {
      alice: new SkillRuntime(skills, `pipeline-${adapterA.id}-${tts.id}`),
      bob: new SkillRuntime(skills, `pipeline-${adapterB.id}-${tts.id}`),
      carol: new SkillRuntime(skills, `pipeline-${adapterC.id}-${tts.id}`),
    };

    const results: Record<string, number> = {};

    const overall = await group("3 sessions parallel push", [
      async () => {
        const tasks = Object.entries(sessions).map(async ([name, session]) => {
          const speakerId = `user-${name}`;
          const runtime = runtimes[name as keyof typeof runtimes];
          const r = await runTurn(session, runtime, speakerId, 10);
          results[name] = r.outputFrames > 0 ? 1 : 0;
        });
        await Promise.all(tasks);
        return true;
      },
      () => Object.values(results).length === 3 ? true : "not all 3 completed",
      () => Object.values(results).every((v) => v === 1) ? true : "one or more sessions failed",
    ]);

    RESULTS.push({
      name: "Phase C -- Multi-session isolation",
      pass: overall,
      detail: `${Object.values(results).filter((v) => v === 1).length}/3 alive`,
    });
  }

  // ===== Phase D: Full-duplex loop =====
  {
    phase("Phase D: Full-duplex -- pulse stream");

    const hermes = new HermesAgent({ id: "hermes-d", processText: async (text) => ({ text: text }) });
    const adapter = createBridgeSkill(hermes.toSkillOptions());
    const tts = new HermesTTS();
    registerSkill(adapter);
    registerSkill(pipe([adapter, tts]));

    const pipelineId = `pipeline-${adapter.id}-${tts.id}`;
    const session = new DefaultAudioSession({ silenceMs: 300 });
    const runtime = new SkillRuntime(skills, pipelineId);

    let completedTurns = 0;
    let missedTurns = 0;
    const pulseCount = 5;
    const frameBurst = 8;

    const overall = await group(`Pulse stream: ${pulseCount} x ${frameBurst}`, [
      async () => {
        const pendingTurns = new Promise<void>((resolve) => {
          let expectedTurns = pulseCount;
          session.onUtterance(async (utterance) => {
            expectedTurns--;
            try {
              const raw: AudioFrame[] = [];
              const src = utterance.audio;
              if (src) for await (const f of src) raw.push(f);

              const playable = {
                speakerId: utterance.speakerId,
                timestamp: utterance.timestamp,
                audio: (async function* () { for (const f of raw) yield f; })(),
              };

              const output: AudioFrame[] = [];
              for await (const f of runtime.processUtterance(playable)) {
                output.push(f);
              }

              if (output.length > 0) completedTurns++;
              else missedTurns++;
            } catch (e) {
              missedTurns++;
            } finally {
              if (expectedTurns <= 0) resolve();
            }
          });
        });

        for (let i = 0; i < pulseCount; i++) {
          for (let j = 0; j < frameBurst; j++) {
            session.push(makeAudioFrame("full-duplex-user"));
          }
          await silence(350);
        }

        await Promise.race([pendingTurns, silence(10000)]);
        return true;
      },
      () => completedTurns > 0 ? true : "zero turns completed",
      () => missedTurns === 0 ? true : `${missedTurns} dead turns`,
      () => (completedTurns + missedTurns) >= pulseCount * 0.8 ? true : "turn starvation",
    ]);

    RESULTS.push({
      name: "Phase D -- Full-duplex loop",
      pass: overall,
      detail: `${completedTurns} ok, ${missedTurns} missed/${pulseCount} pulses`,
    });
  }

  report();
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
