import { execFile } from "node:child_process";

const DEFAULT_VOICE_PREFIX =
  "你是语音助手，回复会被朗读。请用简洁自然的中文口语回答，避免 Markdown 表格和长代码块。用户说：";

export function createAgent(definition) {
  return {
    async chat(text, participantId, signal) {
      const openclawPath = process.env.OPENCLAW_MJS;
      if (!openclawPath) {
        throw new Error("OPENCLAW_MJS is required. Run: veynor agent setup openclaw --openclaw-mjs <path>");
      }

      const agentName = process.env.OPENCLAW_AGENT || "main";
      const voicePrefix = process.env.HERMES_VOICE_PREFIX || DEFAULT_VOICE_PREFIX;
      const sessionKey = `session:${definition.id}:${participantId}`;
      const message = voicePrefix + text;

      return new Promise((resolve, reject) => {
        execFile(
          "node",
          [openclawPath, "agent", "--agent", agentName, "--session-key", sessionKey, "--message", message, "--json"],
          {
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
            signal,
          },
          (err, stdout, stderr) => {
            if (err) {
              reject(new Error(`OpenClaw failed: ${stderr?.toString().slice(-300) || err.message}`));
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
                reject(new Error(`OpenClaw returned empty reply: ${stdout.slice(0, 200)}`));
                return;
              }
              resolve(stripMarkdown(String(reply)));
            } catch {
              reject(new Error(`OpenClaw returned non-JSON output: ${stdout.slice(0, 200)}`));
            }
          },
        );
      });
    },
  };
}

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, "[代码]")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\n{2,}/g, "。")
    .replace(/\n/g, "。")
    .trim();
}
