import { Client, GatewayIntentBits, SlashCommandBuilder } from "discord.js";
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import * as prism from "prism-media";
import { once } from "events";
import { PassThrough } from "stream";
import type { AudioFrame, AudioTransport } from "@veynor/core";
import { FrameQueue } from "@veynor/core";

const DISCORD_PCM = {
  sampleRate: 48000 as const,
  channels: 2 as const,
  frameSize: 960 as const,
};

interface SpeakerStream {
  subscription: any;
  decoder: prism.opus.Decoder;
}

export class DiscordVoiceTransport implements AudioTransport {
  private client: Client;
  private conn: VoiceConnection | null = null;

  get discordClient(): Client {
    return this.client;
  }
  private frameQueue: FrameQueue;
  private speakers = new Map<string, SpeakerStream>();
  private token: string;
  private guildId: string;
  private channelName: string;
  private botUserId: string | null = null;
  private inputEnabled = false;
  private _currentOutput: {
    player: ReturnType<typeof createAudioPlayer>;
    passthrough: PassThrough;
    encoder: prism.opus.Encoder;
    abort: () => void;
  } | null = null;
  private _connectPromise: Promise<void> | null = null;
  private _connectReject: ((err: unknown) => void) | null = null;

  constructor(options: {
    token: string;
    guildId: string;
    channelName: string;
  }) {
    this.token = options.token;
    this.guildId = options.guildId;
    this.channelName = options.channelName;
    this.frameQueue = new FrameQueue();
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async connect(): Promise<void> {
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = new Promise<void>((resolve, reject) => {
      this._connectReject = reject;
      const wrappedReject = (err: unknown) => {
        this._connectPromise = null;
        this._connectReject = null;
        reject(err);
      };
      const wrappedResolve = () => {
        this._connectReject = null;
        resolve();
      };
      const onReady = async () => {
        console.log("[Veynor] Gateway ready, connecting voice...");
        try {
          this.botUserId = this.client.user!.id;

          const guild = this.client.guilds.cache.get(this.guildId);
          if (!guild) {
            throw new Error("Guild not found: " + this.guildId);
          }

          const chs = await guild.channels.fetch();
          // Support both channel name and snowflake ID
          const isSnowflake = /^\d{17,20}$/.test(this.channelName);
          const vc = isSnowflake
            ? chs.get(this.channelName)
            : chs.find((c) => c !== null && c.name === this.channelName && c.type === 2);
          if (!vc || vc.type !== 2) {
            throw new Error("Voice channel not found: " + this.channelName);
          }
          const channelId = vc.id;
          console.log("[Veynor] Channel:", this.channelName, channelId);

          this.conn = joinVoiceChannel({
            channelId: channelId,
            guildId: this.guildId,
            selfDeaf: false,
            selfMute: false,
            adapterCreator: guild.voiceAdapterCreator,
          });

          this.conn.on("stateChange", (o, n) => {
            console.log("[Veynor] Voice:", o.status, "\u2192", n.status);
          });
          this.conn.on("error", (e) => {
            if (/(IP discovery|socket closed)/i.test(e.message)) return;
            console.error("[Veynor] Voice err:", e.message);
          });

          await entersState(this.conn, VoiceConnectionStatus.Ready, 60000);
          console.log("[Veynor] Voice Ready!");

          this._attachVoiceReceivers(this.conn);

          const self = this;
          this.client.on("interactionCreate", async (interaction) => {
            if (!interaction.isChatInputCommand()) return;
            if (interaction.commandName !== "join") return;

            const channel = interaction.options.getChannel("channel", true);
            if (channel.type !== 2) {
              await interaction.reply({ content: "Please select a voice channel.", ephemeral: true });
              return;
            }

            try {
              const chName = (channel as any).name as string;
              await self.switchToChannel(channel.id, chName);
              await interaction.reply({ content: `Joined #${chName}`, ephemeral: true });
            } catch (e) {
              await interaction.reply({ content: `Failed: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
            }
          });

          try {
            const guild = this.client.guilds.cache.get(this.guildId);
            if (!guild) {
              console.error("[Veynor] /join skipped: guild not cached");
            } else {
              const existing = (await guild.commands.fetch())
                .find((c) => c.name === "join");
              if (existing) {
                console.log("[Veynor] /join already registered:", existing.id, "guild:", guild.name);
              } else {
                const cmd = new SlashCommandBuilder()
                  .setName("join")
                  .setDescription("Make the bot join a voice channel")
                  .addChannelOption((opt) =>
                    opt
                      .setName("channel")
                      .setDescription("Which voice channel to join")
                      .setRequired(true)
                      .addChannelTypes(2)
                  );
                const created = await guild.commands.create(cmd);
                console.log("[Veynor] /join registered:", created.id, "guild:", guild.name);
              }
            }
          } catch (e: any) {
            console.error("[Veynor] /join register FAILED");
            console.error("  code:", e?.code);
            console.error("  status:", e?.httpStatus, e?.status);
            console.error("  message:", e?.message);
            console.error("  rawError:", JSON.stringify(e?.rawError ?? e).slice(0, 300));
          }

          wrappedResolve();
        } catch (e) {
          wrappedReject(e);
        }
      };

      this.client.once("clientReady", onReady);

      this.client.on("error", (e) => {
        if (/(IP discovery|socket closed)/i.test(e.message)) return;
        console.error("[Veynor] Client:", e.message);
      });

      this.client.login(this.token).catch(wrappedReject);
    });

    return this._connectPromise;
  }

  input(): AsyncIterable<AudioFrame> {
    this.inputEnabled = true;
    return this.frameQueue;
  }

  stopInput(): void {
    this.inputEnabled = false;
    this.frameQueue.close();
    this.frameQueue = new FrameQueue();
  }

  async output(frames: AsyncIterable<AudioFrame>): Promise<void> {
    if (!this.conn) {
      throw new Error("Not connected");
    }

    // Interrupt: if a previous output() is still in progress, abort it
    // first (barge-in semantics). Without this, the old call's
    // `await playDone` would hang forever because its player is no
    // longer subscribed to the voice connection.
    if (this._currentOutput) {
      console.log("[Veynor] Interrupting previous output");
      this._currentOutput.abort();
    }

    const passthrough = new PassThrough();
    const enc = new prism.opus.Encoder({
      channels: DISCORD_PCM.channels,
      rate: DISCORD_PCM.sampleRate,
      frameSize: DISCORD_PCM.frameSize,
    });
    passthrough.setMaxListeners(0);
    enc.setMaxListeners(0);

    const resource = createAudioResource(passthrough.pipe(enc), {
      inputType: StreamType.Opus,
    });

    const player = createAudioPlayer();

    let settled = false;
    let resolvePlay: () => void = () => {};
    let rejectPlay: (err: Error) => void = () => {};
    const playDone = new Promise<void>((resolve, reject) => {
      resolvePlay = resolve;
      rejectPlay = reject;

      player.on(AudioPlayerStatus.Idle, () => {
        if (settled) return;
        settled = true;
        console.log("[Veynor] Player done");
        resolve();
      });
      player.on("error", (e) => {
        if (settled) return;
        settled = true;
        try { passthrough.destroy(); } catch {}
        reject(new Error(`Player error: ${e.message}`));
      });
    });

    // CRITICAL: opus encoder error handler. Without this, an encoder
    // failure (e.g. malformed PCM input) emits 'error' with no listener,
    // and Node throws "Unhandled 'error' event" — crashing the process.
    enc.on("error", (e) => {
      console.error("[Veynor] Encoder err:", e.message);
      if (settled) return;
      settled = true;
      try { player.stop(true); } catch {}
      try { passthrough.destroy(); } catch {}
      rejectPlay(new Error(`Encoder error: ${e.message}`));
    });

    const active = {
      player,
      passthrough,
      encoder: enc,
      abort: () => {
        if (settled) return;
        settled = true;
        try { player.stop(true); } catch {}
        try { passthrough.destroy(); } catch {}
        rejectPlay(new Error("Output interrupted by new output() call or stopOutput()"));
      },
    };

    this._currentOutput = active;
    player.play(resource);
    this.conn.subscribe(player);
    console.log("[Veynor] \u25B6 Playing");

    try {
      for await (const frame of frames) {
        if (settled || passthrough.destroyed) break;
        const ok = passthrough.write(frame.data);
        if (!ok && !passthrough.destroyed) {
          // Race drain against close so that an abort() (which destroys
          // the passthrough) doesn't leave us stuck waiting for 'drain'.
          await Promise.race([
            once(passthrough, "drain"),
            once(passthrough, "close"),
          ]);
        }
      }
      if (!passthrough.destroyed) {
        passthrough.end();
      }
    } catch (e) {
      if (!settled) {
        settled = true;
        try { passthrough.destroy(); } catch {}
        rejectPlay(e instanceof Error ? e : new Error(String(e)));
      }
      throw e;
    }

    try {
      await playDone;
    } finally {
      if (this._currentOutput === active) {
        this._currentOutput = null;
      }
    }
  }

  stopOutput(): void {
    if (!this._currentOutput) return;
    this._currentOutput.abort();
    console.log("[Veynor] \u25A0 Stopped");
  }

  async disconnect(): Promise<void> {
    const pendingConnect = this._connectPromise;
    const rejectConnect = this._connectReject;
    this._connectReject = null;
    this._connectPromise = null;
    rejectConnect?.(new Error("Transport disconnected while connect() was pending"));

    this.stopOutput();
    this.stopInput();
    for (const uid of this.speakers.keys()) {
      this.cleanupSpeaker(uid);
    }
    if (this.conn) {
      this.conn.destroy();
      this.conn = null;
      console.log("[Veynor] Left voice channel");
    }
    try {
      this.client.destroy();
    } catch {}
    await pendingConnect?.catch(() => {});
  }

  private cleanupSpeaker(uid: string): void {
    const stream = this.speakers.get(uid);
    if (!stream) return;
    try {
      stream.decoder.destroy();
    } catch {}
    stream.subscription.removeAllListeners();
    try {
      stream.subscription.destroy();
    } catch {}
    this.speakers.delete(uid);
  }

  // Subscribe to opus streams for any non-bot speaker that starts
  // talking on `conn`, and push the decoded PCM frames into the
  // shared frame queue. Called from both `onReady` (initial join)
  // and `switchToChannel` (slash-command channel handoff). The
  // closure captures `self` so it can keep working after the call
  // site has returned.
  private _attachVoiceReceivers(conn: VoiceConnection): void {
    const recv = conn.receiver;
    const self = this;
    recv.speaking.on("start", (uid: string) => {
      if (uid === self.botUserId) return;
      if (self.speakers.has(uid)) return;

      console.log("[Veynor] \uD83C\uDFA4 " + uid.slice(-6));

      const opusStream = recv.subscribe(uid);
      const decoder = new prism.opus.Decoder({
        channels: DISCORD_PCM.channels,
        rate: DISCORD_PCM.sampleRate,
        frameSize: DISCORD_PCM.frameSize,
      });

      self.speakers.set(uid, { subscription: opusStream, decoder });

      let count = 0;
      decoder.on("data", (chunk: Buffer) => {
        if (!self.inputEnabled) return;
        count++;
        self.frameQueue.push({
          sampleRate: DISCORD_PCM.sampleRate,
          channels: DISCORD_PCM.channels,
          bitDepth: 16,
          timestamp: Date.now(),
          speakerId: uid,
          data: chunk,
        });
        if (count <= 3 || count % 100 === 0) {
          console.log("[Veynor]   #" + count + " +" + chunk.length + "b [" + uid.slice(-6) + "]");
        }
      });

      opusStream.pipe(decoder);

      opusStream.on("end", () => {
        console.log("[Veynor] \uD83D\uDD07 opus end [" + uid.slice(-6) + "]");
        self.cleanupSpeaker(uid);
      });

      opusStream.on("error", (e: Error) => {
        console.error("[Veynor] opus err:", e.message);
        self.cleanupSpeaker(uid);
      });

      decoder.on("error", (e: Error) => {
        console.error("[Veynor] decoder err:", e.message);
        self.cleanupSpeaker(uid);
      });
    });
  }

  async switchToChannel(channelId: string, channelName: string): Promise<void> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error("Guild not found: " + this.guildId);

    this.stopOutput();
    for (const uid of this.speakers.keys()) {
      this.cleanupSpeaker(uid);
    }

    if (this.conn) {
      this.conn.destroy();
      this.conn = null;
    }

    this.channelName = channelName;

    this.conn = joinVoiceChannel({
      channelId,
      guildId: this.guildId,
      selfDeaf: false,
      selfMute: false,
      adapterCreator: guild.voiceAdapterCreator,
    });

    this.conn.on("stateChange", (o, n) => {
      console.log("[Veynor] Voice:", o.status, "\u2192", n.status);
    });
    this.conn.on("error", (e) => {
      if (/(IP discovery|socket closed)/i.test(e.message)) return;
      console.error("[Veynor] Voice err:", e.message);
    });

    await entersState(this.conn, VoiceConnectionStatus.Ready, 60000);
    console.log("[Veynor] Switched to:", channelName, channelId);

    this._attachVoiceReceivers(this.conn);
  }

}
