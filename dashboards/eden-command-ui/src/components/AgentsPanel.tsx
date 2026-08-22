import { AGENTS } from "../agents";
import HUDPanel from "./HUDPanel";

export default function AgentsPanel() {
  return (
    <HUDPanel title="AGENTS">
      {AGENTS.map((agent) => (
        <div className="agent-row" key={agent.id}>
          <span className="status-dot" />
          <span className="agent-code" style={{ color: agent.color }}>
            {agent.code}
          </span>
          <span className="agent-name">{agent.name}</span>
          <span className="agent-status">online</span>
        </div>
      ))}
    </HUDPanel>
  );
}
