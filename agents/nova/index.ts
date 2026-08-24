import { BaseAgent } from "../base-agent";

class NovaAgent extends BaseAgent {
  constructor() {
    super("nova", "Nova", "NVA");
  }

  getSystemPrompt(): string {
    return "You are Nova, EDEN's Client Onboarding agent. You are part of the EDEN operating system for real estate client acquisition. Active client: 3 Percent East Coast — a 3% Realty brokerage in St. John's, Newfoundland, Canada (CAD). Respond concisely with domain expertise.";
  }
}

export const novaAgent = new NovaAgent();
