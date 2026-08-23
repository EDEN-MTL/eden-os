const MOCK_METRICS = [
  { label: "PIPELINE VALUE", value: "$2.1M", color: "#00ff88" },
  { label: "LEADS TODAY", value: "47", color: "#00b8ff" },
  { label: "ROAS", value: "4.2x", color: "#00fff2" },
];

export default function CoreMetricsPanel() {
  return (
    <div className="panel">
      <div className="panel-title">CORE METRICS</div>
      {MOCK_METRICS.map((m, i) => (
        <div key={m.label}>
          <div className="metric-row">
            <span className="metric-label">{m.label}</span>
            <span className="metric-value" style={{ color: m.color, textShadow: `0 0 16px ${m.color}99` }}>
              {m.value}
            </span>
          </div>
          {i < MOCK_METRICS.length - 1 && <div className="metric-divider" />}
        </div>
      ))}
      <div className="mock-note">Mock data — Lens aggregate feed not wired yet</div>
    </div>
  );
}
