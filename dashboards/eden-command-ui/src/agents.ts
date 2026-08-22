export interface AgentMeta {
  id: string;
  code: string;
  name: string;
  role: string;
  color: string;
}

export const AGENTS: AgentMeta[] = [
  { id: "scout", code: "SCT", name: "Scout", role: "Lead Capture & Enrichment", color: "#00b8ff" },
  { id: "iris", code: "IRS", name: "Iris", role: "AI ISA — Voice & Text", color: "#a78bfa" },
  { id: "atlas", code: "ATL", name: "Atlas", role: "Routing & Booking", color: "#00e5ff" },
  { id: "ember", code: "EMB", name: "Ember", role: "Nurture & Reactivation", color: "#ffa800" },
  { id: "muse", code: "MUS", name: "Muse", role: "Content & Marketing", color: "#ec4899" },
  { id: "forge", code: "FRG", name: "Forge", role: "Ad Engine & Creative", color: "#ff2255" },
  { id: "lens", code: "LNS", name: "Lens", role: "Analytics & Intelligence", color: "#00ff88" },
  { id: "nova", code: "NVA", name: "Nova", role: "Client Onboarding", color: "#f97316" },
];

export const EDEN_COLOR = "#00b8ff";
