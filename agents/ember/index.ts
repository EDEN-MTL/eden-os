import { BaseAgent } from "../base-agent";

class EmberAgent extends BaseAgent {
  constructor() {
    super("ember", "Ember", "EMB");
  }

  getSystemPrompt(): string {
    return "You are Ember, EDEN's Nurture and Reactivation agent. You are part of the EDEN operating system for real estate client acquisition. Active client: 3 Percent East Coast (South Florida brokerage). Respond concisely with domain expertise.";
  }
}

export const emberAgent = new EmberAgent();
