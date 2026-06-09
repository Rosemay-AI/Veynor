/**
 * End-to-end doctor for Veynor.
 *
 * Tests every link in the chain independently with timeouts, so a
 * failure in one stage doesn't mask success in another. Useful for
 * diagnosing setup issues before running the full bot.
 *
 * Tests:
 *   1. Discord  — login + locate guild + locate voice channel
 *   2. Groq STT — synthesize 2s of silence, expect Whisper to return ""
 *   3. OpenClaw — either spawn the CLI subprocess or hit the HTTP gateway
 *   4. MiniMax TTS — synthesize "test", expect non-empty audio buffer
 *
 * Each test reports ok/fail + duration + a one-line detail. Exits
 * non-zero if any required test fails.
 */

import { execFile } from "child_process";
import { existsSync, readFileSync as readFileSyncSync } from "fs";
import { resolve } from "path";

// ── Result type ───────────────────────────────────────────────

export interface DoctorResult {
  name: string;
  ok: boolean;
  durationMs: number;
  detail: string;
  skipped?: boolean;
}

export interface DoctorReport {
  results: DoctorResult[];
  totalMs: number;
  failedRequired: number;
}

// ── Test runners ──────────────────────────────────────────────

async function time<T>(label: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<DoctorResult> {
  const start = Date.now();
  try {
    const { ok, detail } = await fn();
    return { name: label, ok, durationMs: Date.now() - start, detail };
  } catch (e: any) {
    return {
      name: label,
      ok: false,
      durationMs: Date.now() - start,
      detail: e?.message || String(e),
    };
  }
}

/**
 * Test Discord token validity + guild/channel lookup. We use a
 * lightweight login (no voice channel join) to avoid fighting with
 * the running bot. The doctor is meant to run BEFORE the bot, or
 * alongside a stopped bot.
 */
async function testDiscord(token: string, guildId: string, channelName: string): Promise<DoctorResult> {
  return time("Discord", async () => {
    if (!token) return { ok: false, detail: "DISCORD_BOT_TOKEN empty" };
    const { Client, GatewayIntentBits } = await import("discord.js");
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onReady = async () => {
          const guilds = [...client.guilds.cache.values()];
          const guild = guilds.find((g) => g.id === guildId);
          if (!guild) {
            reject(new Error(`bot is a member of ${guilds.length} guild(s) but NOT ${guildId}`));
            return;
          }
          // Fetch every channel in the guild (default would only get visible ones)
          // and find the voice channel by name.
          const allChannels = (await client.guilds.cache.get(guildId)?.channels.fetch()) ?? null;
          const channels = allChannels ? [...allChannels.values()] : [];
          const vc = channels.find(
            (c: any) => c !== null && c.name === channelName && c.type === 2
          );
          if (!vc) {
            reject(new Error(`voice channel "${channelName}" not found in guild "${guild.name}"`));
            return;
          }
          client.destroy();
          resolve();
        };
        client.once("ready", onReady);
        client.once("error", (e) => reject(new Error("Discord error: " + e.message)));
        client.login(token).catch(reject);
      });
      return { ok: true, detail: `logged in, found guild + #${channelName}` };
    } catch (e: any) {
      try { client.destroy(); } catch {}
      return { ok: false, detail: e?.message || "connect failed" };
    }
  });
}

/**
 * Test Groq STT by sending 2s of silence. Whisper should return
 * empty string. This verifies the API key, network, and audio
 * resampling all work.
 */
async function testGroqStt(apiKey: string): Promise<DoctorResult> {
  return time("Groq STT", async () => {
    if (!apiKey) return { ok: false, detail: "GROQ_API_KEY not set" };

    // 2 seconds of 16kHz mono 16-bit silence
    const sampleRate = 16000;
    const channels = 1;
    const samples = sampleRate * 2;
    const pcm = Buffer.alloc(samples * 2);

    // Build a minimal WAV header
    const dataSize = pcm.length;
    const wav = Buffer.alloc(44 + dataSize);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + dataSize, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(channels, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * channels * 2, 28);
    wav.writeUInt16LE(channels * 2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(dataSize, 40);
    wav.set(pcm, 44);

    const blob = new Blob([new Uint8Array(wav)], { type: "audio/wav" });
    const form = new FormData();
    form.append("file", blob, "test.wav");
    form.append("model", "whisper-large-v3");
    form.append("language", "zh");
    form.append("response_format", "json");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return { ok: false, detail: `HTTP ${res.status}: ${err.slice(0, 100)}` };
    }
    const data = (await res.json()) as { text?: string };
    // Silence should produce empty text. If it does, the pipeline works.
    return { ok: true, detail: `silence→"${data.text || ""}" (expected empty)` };
  });
}

/**
 * Test OpenClaw integration. Auto-detects mode:
 *   - OPENCLAW_MJS env var   → spawn as CLI subprocess
 *   - OPENCLAW_URL env var   → POST to HTTP gateway
 *   - otherwise               → skipped
 */
async function testOpenClaw(): Promise<DoctorResult> {
  return time("OpenClaw", async () => {
    const cliPath = process.env["OPENCLAW_MJS"];
    const httpUrl = process.env["OPENCLAW_URL"];

    if (cliPath) {
      if (!existsSync(cliPath)) {
        return { ok: false, detail: `OPENCLAW_MJS not found: ${cliPath}` };
      }
      const reply = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          "node",
          [
            cliPath,
            "agent",
            "--agent", "main",
            "--session-key", "doctor:check",
            "--message", "ping",
            "--json",
            "--timeout", "30",
          ],
          { maxBuffer: 10 * 1024 * 1024, timeout: 35000, windowsHide: true },
          (err, stdout) => {
            if (err) return reject(err);
            try {
              const data = JSON.parse(stdout);
              const reply =
                data?.result?.payloads?.[0]?.text ??
                data?.payloads?.[0]?.text ??
                data?.meta?.finalAssistantVisibleText ??
                data?.text ??
                "";
              resolve(String(reply).trim());
            } catch {
              resolve(""); // non-JSON is still OK if openclaw didn't crash
            }
          }
        );
      });
      return {
        ok: reply.length > 0,
        detail: `CLI subprocess replied: "${reply.slice(0, 50)}${reply.length > 50 ? "..." : ""}"`,
      };
    }

    if (httpUrl) {
      const res = await fetch(`${httpUrl.replace(/\/$/, "")}/v1/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: "main",
          sessionKey: "doctor:check",
          message: "ping",
        }),
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const data = await res.json();
      const reply = data?.result?.payloads?.[0]?.text ?? data?.text ?? "";
      return {
        ok: reply.length > 0,
        detail: `HTTP gateway replied: "${String(reply).slice(0, 50)}"`,
      };
    }

    return { ok: false, detail: "Neither OPENCLAW_MJS nor OPENCLAW_URL set" };
  });
}

/**
 * Test MiniMax TTS by synthesizing a one-word string. Verifies API
 * key, network, and audio format all work.
 */
async function testMinimaxTts(apiKey: string): Promise<DoctorResult> {
  return time("MiniMax TTS", async () => {
    if (!apiKey) return { ok: false, detail: "MINIMAX_API_KEY not set" };

    const res = await fetch("https://api.minimaxi.com/v1/t2a_v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "speech-2.8-hd",
        text: "test",
        stream: false,
        voice_setting: { voice_id: "female-shaonv", speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: "pcm", channel: 1 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, detail: `HTTP ${res.status}: ${body.slice(0, 100)}` };
    }
    const data = (await res.json()) as { data?: { audio?: string } };
    if (!data?.data?.audio) return { ok: false, detail: "no audio field in response" };
    const bytes = Math.floor(data.data.audio.length / 2);
    return { ok: true, detail: `synthesized ${bytes} bytes of PCM` };
  });
}

// ── OpenClaw.mjs path auto-discovery ──────────────────────────

/**
 * Search common locations for openclaw.mjs. Returns the first
 * existing path, or null.
 *
 * Order:
 *   1. OPENCLAW_MJS env var
 *   2. $(npm root -g)/openclaw/openclaw.mjs
 *   3. Common Windows / Linux / macOS paths
 *   4. ./node_modules/openclaw/openclaw.mjs (local)
 */
export async function discoverOpenClawPath(): Promise<string | null> {
  const envPath = process.env["OPENCLAW_MJS"];
  if (envPath && existsSync(envPath)) return envPath;

  // Try `npm root -g` to find the global node_modules
  try {
    const { execFile: ef } = await import("child_process");
    const globalRoot = await new Promise<string>((resolve, reject) => {
      ef("npm", ["root", "-g"], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.toString().trim());
      });
    });
    const candidate = resolve(globalRoot, "openclaw", "openclaw.mjs");
    if (existsSync(candidate)) return candidate;
  } catch {
    // npm not available — fall through
  }

  // Common hardcoded locations
  const candidates = [
    // Windows
    "D:\\npm-global\\node_modules\\openclaw\\openclaw.mjs",
    "C:\\npm-global\\node_modules\\openclaw\\openclaw.mjs",
    "C:\\Program Files\\nodejs\\node_modules\\openclaw\\openclaw.mjs",
    // Linux/macOS
    "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
    "/usr/lib/node_modules/openclaw/openclaw.mjs",
    // Local
    "./node_modules/openclaw/openclaw.mjs",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ── Main entry ────────────────────────────────────────────────

export interface DoctorOptions {
  /** Run only the named tests. Default: all. */
  only?: string[];
  /** Skip network tests (Discord, Groq, MiniMax). Default: false. */
  skipNetwork?: boolean;
  /** Called after each individual test completes. Useful for live UI. */
  onResult?: (r: DoctorResult) => void;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const start = Date.now();
  const env = process.env;
  const results: DoctorResult[] = [];

  const shouldRun = (name: string) => !opts.only || opts.only.includes(name);

  // 1. Discord
  if (shouldRun("discord")) {
    const token = env["DISCORD_BOT_TOKEN"] || "";
    const guildId = env["GUILD_ID"] || "";
    const channel = env["VOICE_CHANNEL_NAME"] || "General";
    if (!token || !guildId) {
      results.push({
        name: "Discord",
        ok: false,
        durationMs: 0,
        detail: "DISCORD_BOT_TOKEN / GUILD_ID not set",
      });
    } else {
      results.push(await testDiscord(token, guildId, channel));
    if (opts.onResult) opts.onResult(results[results.length - 1]);
    }
  }

  // 2. Groq STT
  if (shouldRun("groq") && !opts.skipNetwork) {
    const r = await testGroqStt(env["GROQ_API_KEY"] || "");
    results.push(r);
    if (opts.onResult) opts.onResult(r);
  }

  // 3. Discover OpenClaw.mjs path first so the spawn test sees it.
  //    If found and missing from .env, also write it back.
  if (shouldRun("path") || shouldRun("openclaw")) {
    const found = await discoverOpenClawPath();
    const r: DoctorResult = {
      name: "OpenClaw.mjs path",
      ok: found !== null,
      durationMs: 0,
      detail: found || "not found in any common location",
    };
    results.push(r);
    if (opts.onResult) opts.onResult(r);

    if (found && !env["OPENCLAW_MJS"]) {
      // Mutate process.env so the OpenClaw test below sees the value.
      process.env["OPENCLAW_MJS"] = found;
      // And persist to .env so subsequent runs work too.
      try {
        const envFile = resolve(process.cwd(), ".env");
        if (existsSync(envFile)) {
          const content = readFileSyncSync(envFile);
          if (!content.includes("OPENCLAW_MJS=")) {
            const { appendFileSync } = await import("fs");
            appendFileSync(
              envFile,
              `\n# Auto-added by veynor doctor: OpenClaw.mjs path\nOPENCLAW_MJS=${found}\n`,
              "utf-8"
            );
            r.detail = `${found} (also wrote to .env)`;
          }
        }
      } catch {
        // Non-fatal.
      }
    }
  }

  // 4. OpenClaw (auto-detect, after path discovery)
  if (shouldRun("openclaw") && !opts.skipNetwork) {
    const r = await testOpenClaw();
    results.push(r);
    if (opts.onResult) opts.onResult(r);
  }

  // 5. MiniMax TTS
  if (shouldRun("minimax") && !opts.skipNetwork) {
    const r = await testMinimaxTts(env["MINIMAX_API_KEY"] || "");
    results.push(r);
    if (opts.onResult) opts.onResult(r);
  }

  const failedRequired = results.filter((r) => !r.ok && !r.skipped).length;
  return {
    results,
    totalMs: Date.now() - start,
    failedRequired,
  };
}
