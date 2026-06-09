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

function makeAudioFrame(sampleRate = 48000, channels = 2, bitDepth = 16, ms = 20): AudioFrame {
  const samples = Math.floor((sampleRate * ms) / 1000) * channels;
  const buf = Buffer.alloc(samples * (bitDepth / 8));
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin(i * 0.01) * 1000), i * 2);
  }
  return { sampleRate, channels, bitDepth, timestamp: Date.now(), data: buf };
}

async function main() {
  const hermes = new HermesAgent({
    id: "hermes",
    processText: async (text) => ({ text: `Hermes says: ${text}` }),
  });

  const adapter = createBridgeSkill(hermes.toSkillOptions());
  const tts = new HermesTTS();
  const pipeline = pipe([adapter, tts]);

  registerSkill(adapter);
  registerSkill(pipeline);

  const session = new DefaultAudioSession({ silenceMs: 200 });
  const runtime = new SkillRuntime(skills, pipeline.id);

  let turnCount = 0;

  session.onUtterance(async (utterance) => {
    turnCount++;
    console.log(`\n=== Turn ${turnCount}: ${utterance.speakerId}`);

    const audioFrames: AudioFrame[] = [];
    const source = utterance.audio;
    if (source) {
      for await (const f of source) audioFrames.push(f);
    }
    console.log(`  Audio input: ${audioFrames.length} frames`);

    const playable = {
      speakerId: utterance.speakerId,
      timestamp: utterance.timestamp,
      audio: (async function* () {
        for (const f of audioFrames) yield f;
      })(),
    };

    const output: AudioFrame[] = [];
    for await (const frame of runtime.processUtterance(playable)) {
      output.push(frame);
    }

    if (output.length === 0) {
      console.log("  ❌ NO OUTPUT — pipeline broken");
      return;
    }

    const bytes = output.reduce((s, f) => s + f.data.length, 0);
    const durMs = Math.round((output.length * 20 * 1000) / 48);
    console.log(`  ✅ Output: ${output.length} frames, ${bytes} bytes, ~${durMs}ms audio`);
  });

  const speakers = ["alice", "bob", "carol"];
  for (let i = 0; i < speakers.length; i++) {
    console.log(`\n--- Feeding audio for speaker: ${speakers[i]}`);
    for (let j = 0; j < 15; j++) {
      const frame = makeAudioFrame();
      frame.speakerId = speakers[i];
      session.push(frame);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("\n=== Integration test complete ===");
  console.log(`Total turns: ${turnCount}/3`);
  console.log(turnCount === 3 ? "✅ ALL 3 TURNS PROCESSED" : "❌ EXPECTED 3 TURNS");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
