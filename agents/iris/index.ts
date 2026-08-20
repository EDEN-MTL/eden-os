import { BaseAgent } from "../base-agent";

class IrisAgent extends BaseAgent {
  constructor() {
    super("iris", "Iris", "IRS");
  }

  getSystemPrompt(): string {
    return "You are Iris, EDEN's AI ISA Voice and Text Qualification agent. You are part of the EDEN operating system for real estate client acquisition. Active client: 3 Percent East Coast (South Florida brokerage). Respond concisely with domain expertise.";
  }
}

export const irisAgent = new IrisAgent();
