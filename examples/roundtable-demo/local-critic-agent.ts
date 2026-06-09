import type { Agent } from "@veynor/agent";

const agent: Agent = {
  async chat(text) {
    const intent = text.match(/Your speaking intent: (.+)/)?.[1] ?? "unknown";
    return `Critic registry contribution for ${intent}.`;
  },
};

export default agent;
