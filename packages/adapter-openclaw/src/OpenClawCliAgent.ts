/**
 * OpenClawCliAgent — wraps the OpenClaw CLI subprocess as a Veynor Agent.
 *
 * The user's local OpenClaw install exposes a CLI entry point
 * (`openclaw.mjs`) that takes a message on stdin/argv and prints the
 * assistant reply on stdout. We shell out to it for every user turn.
 *
 * This is the *original* integration the user had (see
 * examples/hermes-demo/main.ts before this adapter existed).
 *
 * Usage:
 *   import { OpenClawCliAgent, VeynorSkill } from "@veynor/core";
 *
 *   const agent = new OpenClawCliAgent({
 *     openclawPath: "D:\\npm-global\\node_modules\\openclaw\\openclaw.mjs",
 *     agentName: "main",
 *     voicePrefix: "你是语音助手，…",  // optional, prepended to each message
 *   }).toSkillOptions().agent;
 *
 *   const skill = new VeynorSkill(agent, { ... });
 */

import { execFile } from "child_process";

/** Local Agent-like type (mirrors @veynor/agent's Agent shape). */
export interface AgentLike {
  chat(text: string, participantId: string): Promise<string>;
}

export interface OpenClawCliAgentOptions {
  /** Absolute path to openclaw.mjs (or `openclaw.cmd` on Windows). */
  openclawPath: string;
  /** OpenClaw agent name. Default: "main". */
  agentName?: string;
  /**
   * Prepended to every message before it goes to OpenClaw. Use this to
   * inject voice-style instructions ("reply concisely, use TTS-friendly
   * punctuation") so the LLM's output reads well when spoken aloud.
   */
  voicePrefix?: string;
  /** Subprocess timeout in ms. Default: 65000. */
  timeoutMs?: number;
  /** Max stdout buffer in bytes. Default: 10MB. */
  maxBuffer?: number;
}

const DEFAULT_VOICE_PREFIX =
  "你是语音助手，回复会被朗读。用标点控制语气：逗号停顿，省略号犹豫，感叹号加重，波浪号～轻快，句号平稳收尾。直接回复，不要思考过程。用户说：";

export class OpenClawCliAgent {
  private opts: Required<OpenClawCliAgentOptions>;

  constructor(opts: OpenClawCliAgentOptions) {
    this.opts = {
      openclawPath: opts.openclawPath,
      agentName: opts.agentName ?? "main",
      voicePrefix: opts.voicePrefix ?? DEFAULT_VOICE_PREFIX,
      timeoutMs: opts.timeoutMs ?? 65000,
      maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
    };
  }

  toSkillOptions(): { agent: AgentLike } {
    const self = this;
    const agent: AgentLike = {
      async chat(text: string, participantId: string): Promise<string> {
        const key = `agent:${self.opts.agentName}:${participantId}`;
        const message = self.opts.voicePrefix + text;

        return new Promise((resolve, reject) => {
          const started = Date.now();
          execFile(
            "node",
            [
              self.opts.openclawPath,
              "agent",
              "--agent", self.opts.agentName,
              "--session-key", key,
              `--message=${message}`,
              "--json",
              "--timeout", "60",
            ],
            {
              maxBuffer: self.opts.maxBuffer,
              timeout: self.opts.timeoutMs,
              windowsHide: true,
            },
            (err, stdout, stderr) => {
              const elapsed = Date.now() - started;
              if (err) {
                const code = (err as any).code;
                const killed = (err as any).killed;
                reject(
                  new Error(
                    `openclaw.mjs failed (${elapsed}ms, exit=${code ?? "?"}, ` +
                    `killed=${killed}): ${stderr?.toString().slice(-200) || err.message}`
                  )
                );
                return;
              }
              try {
                const data = JSON.parse(stdout);
                const reply =
                  data?.result?.payloads?.[0]?.text ??
                  data?.payloads?.[0]?.text ??
                  data?.meta?.finalAssistantVisibleText ??
                  data?.result?.finalAssistantVisibleText ??
                  data?.result?.finalAssistantRawText ??
                  data?.text ??
                  "";
                if (!reply) {
                  reject(new Error(`openclaw.mjs returned empty reply: ${stdout.slice(0, 200)}`));
                  return;
                }
                resolve(String(reply).trim());
              } catch (parseErr) {
                reject(
                  new Error(
                    `openclaw.mjs returned non-JSON output: ${stdout?.toString().slice(0, 200)}`
                  )
                );
              }
            }
          );
        });
      },
    };
    return { agent };
  }
}
