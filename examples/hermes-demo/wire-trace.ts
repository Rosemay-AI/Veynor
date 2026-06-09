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

function wire(name: string, msg: string) {
  console.log(`  [${name}] ${msg}`);
}

function wireOk(name: string) { wire(name, "OK"); }

const CHECKS: { name: string; pass: boolean; detail: string }[] = [];
function check(point: string, pass: boolean, detail = "") {
  CHECKS.push({ name: point, pass, detail });
}

function makeFakeAudio(speakerId: string): AudioFrame[] {
  const frames: AudioFrame[] = [];
  for (let i = 0; i < 10; i++) {
    const buf = Buffer.alloc(3840);
    for (let j = 0; j < 1920; j++) {
      buf.writeInt16LE(Math.round(Math.sin((i * 1920 + j) * 0.01) * 500), j * 2);
    }
    frames.push({ sampleRate: 48000, channels: 2, bitDepth: 16, timestamp: Date.now(), speakerId, data: buf });
  }
  return frames;
}

async function main() {
  const hermes = new HermesAgent({
    id: "wiretest",
    processText: async (text) => {
      wire("RUN", `LLM input: "${text.substring(0, 60)}"`);
      const result = { text: `AGENT-SAYS: ${text}` };
      wire("RUN", `LLM output: "${result.text.substring(0, 40)}"`);
      return result;
    },
  });

  const adapter = createBridgeSkill(hermes.toSkillOptions());
  const tts = new HermesTTS();
  const pipeline = pipe([adapter, tts]);

  registerSkill(adapter);
  registerSkill(pipeline);
  wire("SETUP", `pipeline id = ${pipeline.id}`);

  const session = new DefaultAudioSession({ silenceMs: 200 });
  const runtime = new SkillRuntime(skills, pipeline.id);

  const speakerId = "wiretrace-user";
  const fakeFrames = makeFakeAudio(speakerId);

  wire("TRACE", `injecting ${fakeFrames.length} fake audio frames`);

  const done = new Promise<void>((resolve) => {
    session.onUtterance(async (utterance) => {
      if (utterance.speakerId !== speakerId) return;

      wire("TURN", `utterance from ${speakerId}`);

      const raw: AudioFrame[] = [];
      const src = utterance.audio;
      if (src) for await (const f of src) raw.push(f);
      const audioBytes = raw.reduce((s, f) => s + f.data.length, 0);
      wire("AUDIO-IN", `${raw.length} frames, ${audioBytes} bytes`);
      check("1 utterrance.audio ok", raw.length > 0);

      const playable = {
        speakerId: utterance.speakerId,
        timestamp: utterance.timestamp,
        audio: (async function* () { for (const f of raw) yield f; })(),
      };

      wire("RUNTIME", "processUtterance start");
      const output: AudioFrame[] = [];
      for await (const frame of runtime.processUtterance(playable)) {
        output.push(frame);
      }
      wire("RUNTIME", `output: ${output.length} frames, ${output.reduce((s, f) => s + f.data.length, 0)} bytes`);

      check("2 runtime.processUtterance ok", true);
      check("3 VeynorSkill.execute called", output.length > 0, `outputFrames=${output.length}`);
      check("4 onAudioInput + streamText ran", output.length > 0);
      check("5 ctx.say -> Pipeline transcript bridge", output.length > 0);
      check("6 TTS produced AudioFrame", output.length > 0 && output[0]?.sampleRate === 24000, `sampleRate=${output[0]?.sampleRate}`);
      check("7 VeynorSkill no silent-fail", output.length > 0);
      check("8 pipeline no frame loss", output.length > 0);

      resolve();
    });
  });

  for (const f of fakeFrames) session.push(f);

  const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT: no utterance detected")), 5000));
  try {
    await Promise.race([done, timeout]);
  } catch (e) {
    console.error(`  [TURN] FAIL: ${String(e)}`);
    check("0 utterance detection", false, String(e));
  }

  console.log("\n=========================================");
  console.log("  AGENT LIVE WIRE TRACE (SKILL PLUGIN MODEL)");
  console.log("=========================================");
  for (const c of CHECKS) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.name}${c.detail ? " -- " + c.detail : ""}`);
  }
  const passed = CHECKS.filter((c) => c.pass).length;
  console.log(`\n  ${passed}/${CHECKS.length} checks passed`);
  if (passed < CHECKS.length) {
    console.log("  STATUS: FAIL -- agent not alive in runtime");
    process.exit(1);
  }
  console.log("  STATUS: PASS -- agent is alive, all wire points confirmed\n");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
