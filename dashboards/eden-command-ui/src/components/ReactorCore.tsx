import { AGENTS } from "../agents";

export default function ReactorCore() {
  const radius = 110;

  return (
    <div className="reactor-wrap">
      <div className="reactor">
        <div className="reactor-ring r1" />
        <div className="reactor-ring r2" />
        <div className="reactor-ring r3" />
        <div className="reactor-crosshair" />
        <div className="reactor-core" />
        {AGENTS.map((agent, i) => {
          const angle = (i / AGENTS.length) * 2 * Math.PI - Math.PI / 2;
          const x = 110 + radius * Math.cos(angle) - 3.5;
          const y = 110 + radius * Math.sin(angle) - 3.5;
          return (
            <div
              key={agent.id}
              className="reactor-node"
              title={agent.name}
              style={{
                left: x,
                top: y,
                color: agent.color,
                background: agent.color,
                animationDelay: `${i * 0.2}s`,
              }}
            />
          );
        })}
      </div>
      <div className="reactor-label">
        <div className="title">CENTRAL INTELLIGENCE</div>
        <div className="subtitle">MULTI-AGENT ORCHESTRATION ACTIVE</div>
      </div>
    </div>
  );
}
