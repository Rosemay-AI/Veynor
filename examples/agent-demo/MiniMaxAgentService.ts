import https from "https";

export interface AgentResult {
  reply: string;
  durationMs: number;
}

export interface AgentService {
  chat(text: string): Promise<AgentResult>;
}

function stripThink(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export class MiniMaxAgentService implements AgentService {
  private apiKey: string;
  private model: string;

  constructor(options: { apiKey: string; model?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "MiniMax-M3";
  }

  async chat(text: string): Promise<AgentResult> {
    const start = Date.now();

    const now = new Date();
    const timeStr = now.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    });

    const sysPrompt =
      "你是语音助手机器人。现在时间是" +
      timeStr +
      "。用简短口语回复，每次不超过40字。";

    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: text },
      ],
      max_completion_tokens: 256,
      temperature: 0.7,
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "api.minimaxi.com",
          port: 443,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Authorization": "Bearer " + this.apiKey,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            try {
              const r = JSON.parse(d);
              if (r?.base_resp?.status_code && r.base_resp.status_code !== 0) {
                console.error("[LLM] FULL RESPONSE:");
                console.error(JSON.stringify(r, null, 2));
                reject(
                  new Error(
                    "MiniMax LLM API: " +
                      JSON.stringify(r)
                  )
                );
                return;
              }
              let reply = r?.choices?.[0]?.message?.content || "";
              reply = stripThink(reply);
              if (reply) {
                resolve({
                  reply: String(reply).slice(0, 500),
                  durationMs: Date.now() - start,
                });
              } else {
                reject(new Error("MiniMax LLM empty"));
              }
            } catch (e: any) {
              reject(new Error("MiniMax parse: " + e.message));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}
