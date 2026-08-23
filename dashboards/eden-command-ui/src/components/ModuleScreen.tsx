import { MODULES } from "../modules";

export default function ModuleScreen({ tab }: { tab: string }) {
  const mod = MODULES[tab] || MODULES.LEADS;

  return (
    <div className="module-screen">
      <div className="module-inner">
        <div className="module-eyebrow">{mod.eyebrow}</div>
        <div className="module-title">{mod.title}</div>
        <div className="module-title-line" />

        <div className="module-metrics-grid">
          {mod.metrics.map((k: any) => (
            <div className="panel glow module-metric-card" key={k.label}>
              <div className="module-metric-label">{k.label}</div>
              <div className="module-metric-value-row">
                <span className="module-metric-value" style={{ color: k.color, textShadow: `0 0 20px ${k.glow}` }}>
                  {k.value}
                </span>
                {k.delta && <span className="module-metric-delta">{k.delta}</span>}
              </div>
            </div>
          ))}
        </div>

        <div className="module-body-grid">
          <div className="panel">
            <div className="panel-title-row">
              <span className="panel-title" style={{ marginBottom: 0 }}>
                {mod.feedLabel}
              </span>
              <span className="live-tag">
                <span className="rec-dot" />
                REAL-TIME FEED
              </span>
            </div>
            <div className="feed-list">
              {mod.feed.map((f: any, i: number) => (
                <div className="module-feed-item" key={i}>
                  <div className="feed-bar" style={{ background: f.color, boxShadow: `0 0 10px 1px ${f.glow}` }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="feed-meta">
                      <span className="feed-agent" style={{ color: f.color, textShadow: `0 0 10px ${f.glow}` }}>
                        {f.agent}
                      </span>
                      <span className="feed-time">{f.time}</span>
                    </div>
                    <div className="feed-text">{f.text}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">{mod.sideLabel}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {mod.side.map((s: any, i: number) => (
                <div className="module-side-item" style={{ borderColor: s.color }} key={i}>
                  <div className="module-side-head" style={{ color: s.color, textShadow: `0 0 10px ${s.glow}` }}>
                    {s.head}
                  </div>
                  <div className="module-side-text">{s.text}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mock-note" style={{ marginTop: 24 }}>
          Mock data — this module isn't wired to a real backend yet
        </div>
      </div>
    </div>
  );
}
