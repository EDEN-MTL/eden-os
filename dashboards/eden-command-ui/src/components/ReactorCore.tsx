import { AGENTS, REACTOR_POSITIONS } from "../agents";

export default function ReactorCore({
  selectedAgent,
  onSelectAgent,
  voiceLevel,
}: {
  selectedAgent: string;
  onSelectAgent: (code: string) => void;
  voiceLevel: number;
}) {
  return (
    <div className="reactor-col">
      <div className="reactor" style={{ "--voice-level": voiceLevel } as React.CSSProperties}>
        <div className="reactor-ring outer">
          <span style={{ position: "absolute", top: -1, left: "50%", width: 1, height: 14, background: "#00fff2" }} />
          <span style={{ position: "absolute", bottom: -1, left: "50%", width: 1, height: 14, background: "rgba(0,184,255,.5)" }} />
        </div>
        <div className="reactor-arc a1" />
        <div className="reactor-ring dashed" />
        <div className="reactor-arc a2" />
        <div className="reactor-ring mid">
          <span
            style={{
              position: "absolute",
              top: -3,
              left: "50%",
              width: 5,
              height: 5,
              marginLeft: -2,
              borderRadius: "50%",
              background: "#00fff2",
              boxShadow: "0 0 10px 2px rgba(0,255,242,.9)",
              display: "block",
            }}
          />
        </div>
        <div className="reactor-ring tickmarks" />
        <div className="reactor-ring inner" />
        <div className="reactor-ring tickmarks2" />

        <div className="reactor-core-wrap">
          <div className="reactor-core-inner" />
        </div>
        <div className="reactor-halo" />
        <div className="reactor-halo2" />

        {AGENTS.map((agent) => {
          const pos = REACTOR_POSITIONS[agent.code];
          return (
            <button
              key={agent.code}
              type="button"
              className={`agent-node ${selectedAgent === agent.code ? "selected" : ""}`}
              style={{ left: pos.x, top: pos.y }}
              title={agent.name}
              onClick={() => onSelectAgent(agent.code)}
            >
              <span className="dot" style={{ background: agent.color, boxShadow: `0 0 12px 3px ${agent.color}99` }} />
              <span
                className="label"
                style={{
                  transform: `translate(calc(-50% + ${pos.labelDx}px), calc(-50% + ${pos.labelDy}px))`,
                  color: agent.color,
                  textShadow: `0 0 10px ${agent.color}cc`,
                }}
              >
                {agent.code}
              </span>
            </button>
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
