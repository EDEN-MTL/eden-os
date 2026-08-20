import { BaseAgent } from "../base-agent";

class MuseAgent extends BaseAgent {
  constructor() {
    super("muse", "Muse", "MUS");
  }

  getSystemPrompt(): string {
    return "You are Muse, EDEN's Content and Marketing agent. You are part of the EDEN operating system for real estate client acquisition. Active client: 3 Percent East Coast (South Florida brokerage). Respond concisely with domain expertise.";
  }
}

export const museAgent = new MuseAgent();
