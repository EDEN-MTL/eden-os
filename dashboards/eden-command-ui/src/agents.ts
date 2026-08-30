export interface AgentMeta {
  id: string;
  code: string;
  name: string;
  role: string;
  status: string;
  color: string;
}

export const AGENTS: AgentMeta[] = [
  { id: "scout", code: "SCT", name: "Scout", role: "Lead Capture & Enrichment", status: "CAPTURING", color: "#00b8ff" },
  { id: "iris", code: "IRS", name: "Iris", role: "AI ISA Voice & Text", status: "ON CALL", color: "#a78bfa" },
  { id: "atlas", code: "ATL", name: "Atlas", role: "Routing & Booking", status: "ROUTING", color: "#00e5ff" },
  { id: "ember", code: "EMB", name: "Ember", role: "Nurture & Reactivation", status: "NURTURING", color: "#ffa800" },
  { id: "muse", code: "MUS", name: "Muse", role: "Content & Marketing", status: "DRAFTING", color: "#ec4899" },
  { id: "forge", code: "FRG", name: "Forge", role: "Ad Engine & Creative", status: "OPTIMIZING", color: "#ff2255" },
  { id: "lens", code: "LNS", name: "Lens", role: "Analytics & Intelligence", status: "ANALYZING", color: "#00ff88" },
  { id: "nova", code: "NVA", name: "Nova", role: "Client Onboarding", status: "STANDBY", color: "#f97316" },
];

// Orbiting node positions on the reactor ring (matches the design brief layout — 8 agents evenly spaced)
export const REACTOR_POSITIONS: Record<string, { x: number; y: number; labelDx: number; labelDy: number }> = {
  SCT: { x: 130, y: 25, labelDx: 0, labelDy: -19 },
  IRS: { x: 204, y: 56, labelDx: 23, labelDy: -16 },
  ATL: { x: 235, y: 130, labelDx: 19, labelDy: 0 },
  EMB: { x: 204, y: 204, labelDx: 23, labelDy: 16 },
  MUS: { x: 130, y: 235, labelDx: 0, labelDy: 19 },
  FRG: { x: 56, y: 204, labelDx: -23, labelDy: 16 },
  LNS: { x: 25, y: 130, labelDx: -19, labelDy: 0 },
  NVA: { x: 56, y: 56, labelDx: -23, labelDy: -16 },
};

export function glow(hex: string, alpha = 0.55): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export const EDEN_COLOR = "#00fff2";

/** The central orb isn't one of the 8 orbiting AGENTS — it's EDEN itself. */
export const EDEN_META: AgentMeta = {
  id: "eden",
  code: "EDEN",
  name: "EDEN",
  role: "Central Intelligence",
  status: "ORCHESTRATING",
  color: EDEN_COLOR,
};

/** Resolves a reactor node code (an orbiting agent's code, or "EDEN") to its metadata. */
export function agentByCode(code: string): AgentMeta {
  if (code === "EDEN") return EDEN_META;
  return AGENTS.find((a) => a.code === code) || EDEN_META;
}
