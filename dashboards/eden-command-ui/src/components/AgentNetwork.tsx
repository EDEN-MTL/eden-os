import { AGENTS } from "../agents";

/**
 * The agent roster as an org chart: EDEN on top, specialists below.
 *
 * The hierarchy is the actual architecture, not decoration — EDEN holds the
 * system prompt that knows every agent's remit and routes work to them, and
 * the others each own one function. Drawing it flat would hide that.
 */

type Status = "working" | "waiting" | "idle";

/**
 * What each agent is really doing today, which is mostly nothing.
 *
 * Deliberately honest: only EDEN and Scout have implementations, and Scout is
 * built but has no trigger wired, so it is idle in practice. Showing eight
 * green "working" pills would make the system look finished when seven of the
 * nine agents are still a name and a prompt.
 */
const STATE: Record<string, { status: Status; note: string; model: string }> = {
  eden:  { status: "working", note: "Routes work, answers in chat and by voice, holds cross-agent context.", model: "claude-opus-5" },
  scout: { status: "waiting", note: "Built and tested. Reads and scores inbound leads — no trigger wired yet.", model: "claude-opus-5" },
  iris:  { status: "waiting", note: "In build with Mark. Voice and text ISA on Vapi; owns the call cadence.", model: "vapi + claude" },
  atlas: { status: "idle",    note: "Not started. Routing and booking; Iris books directly until it exists.", model: "—" },
  ember: { status: "idle",    note: "Not started. Nurture and reactivation of dormant leads.", model: "—" },
  muse:  { status: "idle",    note: "Not started. Content and campaign drafting.", model: "—" },
  forge: { status: "idle",    note: "Ad rules and creative generation exist; the agent shell does not.", model: "claude-opus-5" },
  lens:  { status: "idle",    note: "Not started. Reporting and bottleneck detection.", model: "—" },
  nova:  { status: "idle",    note: "Not started. Client onboarding checklists.", model: "—" },
};

function AgentCard({
  code, name, role, color, selected, onSelect,
}: {
  code: string; name: string; role: string; color: string;
  selected: boolean; onSelect: () => void;
}) {
  const id = AGENTS.find((a) => a.code === code)?.id || "";
  const s = STATE[id] || { status: "idle" as Status, note: "", model: "—" };
  return (
    <button className={`agent-card${selected ? " selected" : ""}`} onClick={onSelect}>
      <div className="agent-card-top">
        <span className="agent-avatar" style={{ background: `${color}22`, borderColor: `${color}66`, color }}>
          {code}
        </span>
        <span className={`status-pill ${s.status}`}>{s.status}</span>
      </div>
      <div className="agent-card-name">{name}</div>
      <div className="agent-card-role">{role}</div>
      <p className="agent-card-note">{s.note}</p>
      <div className="agent-card-foot">
        <span className="meta-label">Model</span>
        <span className="meta-value">{s.model}</span>
      </div>
    </button>
  );
}

export default function AgentNetwork({
  selectedAgent, onSelectAgent,
}: { selectedAgent: string; onSelectAgent: (code: string) => void }) {
  const specialists = AGENTS.filter((a) => a.id !== "eden");
  const eden = STATE.eden;

  return (
    <div className="screen">
      <div className="screen-head">
        <div className="screen-eyebrow">Agent Network</div>
        <h1 className="screen-title">Agents</h1>
        <p className="screen-sub">
          One command brain coordinating eight specialist roles. Two are running today;
          the rest are defined but not yet built.
        </p>
      </div>

      <div className="network">
        <div className="orchestrator">
          <div className="agent-card orchestrator-card">
            <div className="agent-card-top">
              <span className="agent-avatar orchestrator-avatar">EDN</span>
              <span className={`status-pill ${eden.status}`}>{eden.status}</span>
            </div>
            <div className="agent-card-name">EDEN</div>
            <div className="agent-card-role">Command Layer</div>
            <p className="agent-card-note">{eden.note}</p>
            <div className="agent-card-foot">
              <span className="meta-label">Model</span>
              <span className="meta-value">{eden.model}</span>
            </div>
          </div>
        </div>

        {/*
          A trunk and a spanning bar, with no per-card stubs.

          The grid is auto-fit, so the column count changes with viewport width
          — four here, two on a narrow window. Stubs drawn at fixed positions
          would point at the gaps between cards as soon as that happens, which
          looks broken in a way a plain bar never does.
        */}
        <svg className="network-links" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <line x1="50" y1="0" x2="50" y2="6" />
          <line x1="4" y1="6" x2="96" y2="6" />
        </svg>

        <div className="agent-grid">
          {specialists.map((a) => (
            <AgentCard
              key={a.code}
              code={a.code}
              name={a.name}
              role={a.role}
              color={a.color}
              selected={selectedAgent === a.code}
              onSelect={() => onSelectAgent(a.code)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
