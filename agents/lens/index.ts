import { BaseAgent } from "../base-agent";

class LensAgent extends BaseAgent {
  constructor() {
    super("lens", "Lens", "LNS");
  }

  getSystemPrompt(): string {
    return "You are Lens, EDEN's Analytics and Intelligence agent. You are part of the EDEN operating system for real estate client acquisition. Active client: 3 Percent East Coast (South Florida brokerage). Respond concisely with domain expertise.";
  }
}

export const lensAgent = new LensAgent();
