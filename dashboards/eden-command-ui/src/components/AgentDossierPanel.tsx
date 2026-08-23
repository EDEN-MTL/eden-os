import { AGENTS, glow } from "../agents";
import { DOSSIER } from "../modules";

export default function AgentDossierPanel({ selectedCode }: { selectedCode: string }) {
  const agent = AGENTS.find((a) => a.code === selectedCode) || AGENTS[0];
  const dossier = DOSSIER[agent.code];
  const agentGlow = glow(agent.color, 0.6);

  return (
    <div className="panel glow">
      <div className="dossier-header">
        <span className="dossier-eyebrow">AGENT DOSSIER</span>
        <span className="dossier-hint">NODE SELECT</span>
      </div>
      <div className="dossier-title-row">
        <span className="dossier-code" style={{ color: agent.color, textShadow: `0 0 20px ${agentGlow}` }}>
          {agent.code}
        </span>
        <span className="dossier-name">{agent.name.toUpperCase()}</span>
      </div>
      <div className="dossier-role">{agent.role}</div>
      <div className="dossier-online">
        <span className="status-dot" />
        ONLINE · {agent.status}
      </div>
      <div style={{ borderLeft: `2px solid ${agent.color}`, paddingLeft: 12 }}>
        <div className="dossier-task-label">CURRENT TASK</div>
        <div className="dossier-task">{dossier.task}</div>
      </div>
      <div className="dossier-metrics">
        <div className="dossier-metric">
          <div className="label">{dossier.m1l}</div>
          <div className="value" style={{ color: agent.color, textShadow: `0 0 12px ${agentGlow}` }}>
            {dossier.m1v}
          </div>
        </div>
        <div className="dossier-metric">
          <div className="label">{dossier.m2l}</div>
          <div className="value" style={{ color: "#00fff2", textShadow: "0 0 12px rgba(0,255,242,.5)" }}>
            {dossier.m2v}
          </div>
        </div>
      </div>
      <div className="mock-note">Mock data — no live per-agent telemetry wired yet</div>
    </div>
  );
}
