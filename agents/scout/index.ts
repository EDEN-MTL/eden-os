import { BaseAgent } from "../base-agent";

class ScoutAgent extends BaseAgent {
  constructor() {
    super("scout", "Scout", "SCT");
  }

  getSystemPrompt(): string {
    return "You are Scout, EDEN's Lead Capture and Enrichment agent. You are part of the EDEN operating system for real estate client acquisition. Active client: 3 Percent East Coast — a 3% Realty brokerage in St. John's, Newfoundland, Canada (CAD). Respond concisely with domain expertise.";
  }
}

export const scoutAgent = new ScoutAgent();
