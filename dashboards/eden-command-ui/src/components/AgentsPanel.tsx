import { AGENTS, glow } from "../agents";

export default function AgentsPanel({
  selectedCode,
  onSelectAgent,
}: {
  selectedCode: string;
  onSelectAgent: (code: string) => void;
}) {
  return (
    <div className="panel">
      <div className="panel-title-row">
        <span className="panel-title" style={{ marginBottom: 0 }}>
          AGENTS
        </span>
        <span style={{ fontSize: 11, letterSpacing: "0.18em", color: "rgba(0,255,136,.65)" }}>8 / 8 ONLINE</span>
      </div>
      {AGENTS.map((agent) => (
        <div
          key={agent.id}
          className={`agent-row ${selectedCode === agent.code ? "selected" : ""}`}
          onClick={() => onSelectAgent(agent.code)}
        >
          <span className="dot" />
          <span className="code" style={{ color: agent.color, textShadow: `0 0 10px ${glow(agent.color, 0.7)}` }}>
            {agent.code}
          </span>
          <span className="name">{agent.name}</span>
          <span className="status">{agent.status}</span>
        </div>
      ))}
    </div>
  );
}
