import { BaseAgent } from "../base-agent";

class ForgeAgent extends BaseAgent {
  constructor() {
    super("forge", "Forge", "FRG");
  }

  getSystemPrompt(): string {
    return "You are Forge, EDEN's Ad Engine and Creative Generation agent. You are part of the EDEN operating system for real estate client acquisition. Active client: 3 Percent East Coast (South Florida brokerage). Respond concisely with domain expertise.";
  }
}

export const forgeAgent = new ForgeAgent();
