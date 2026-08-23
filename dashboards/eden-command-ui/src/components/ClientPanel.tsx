const MOCK_CLIENT_METRICS = [
  { label: "LEADS MTD", value: "312", color: "#00b8ff" },
  { label: "APPTS", value: "67", color: "#00fff2" },
  { label: "SPEND", value: "$8.4k", color: "#ffa800" },
  { label: "CPL", value: "$18", color: "#00ff88" },
];

export default function ClientPanel() {
  return (
    <div className="panel green">
      <div className="panel-title">ACTIVE CLIENT</div>
      <div className="client-name">3 PERCENT EAST COAST</div>
      <div className="client-status">
        <span className="status-dot" />
        OPERATIONAL
      </div>
      <div className="client-grid">
        {MOCK_CLIENT_METRICS.map((m) => (
          <div className="client-metric" key={m.label}>
            <div className="label">{m.label}</div>
            <div className="value" style={{ color: m.color, textShadow: `0 0 12px ${m.color}88` }}>
              {m.value}
            </div>
          </div>
        ))}
      </div>
      <div className="mock-note">Mock data — GHL/Meta client feed not wired yet</div>
    </div>
  );
}
