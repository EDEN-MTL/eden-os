import HUDPanel from "./HUDPanel";

// Placeholder values — Lens doesn't have real GHL/Meta data wired in yet.
// Swap this for a real fetch once Lens exposes an aggregate metrics endpoint.
const MOCK_METRICS = [
  { label: "PIPELINE VALUE", value: "$2.1M", color: "#22ff88" },
  { label: "LEADS TODAY", value: "47", color: "#00b8ff" },
  { label: "ROAS", value: "4.2x", color: "#00fff2" },
];

export default function CoreMetricsPanel() {
  return (
    <HUDPanel title="CORE METRICS">
      {MOCK_METRICS.map((m) => (
        <div className="metric-row" key={m.label}>
          <span className="metric-label">{m.label}</span>
          <span className="metric-value" style={{ color: m.color }}>
            {m.value}
          </span>
        </div>
      ))}
      <div className="mock-note">Mock data — Lens aggregate feed not wired yet</div>
    </HUDPanel>
  );
}
