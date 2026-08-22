import HUDPanel from "./HUDPanel";

const MOCK_CLIENT_METRICS = [
  { label: "LEADS MTD", value: "312" },
  { label: "APPTS", value: "67" },
  { label: "SPEND", value: "$8.4k" },
  { label: "CPL", value: "$18" },
];

export default function ClientPanel() {
  return (
    <HUDPanel title="ACTIVE CLIENT">
      <div className="client-name">3 PERCENT EAST COAST</div>
      <div className="client-status">● OPERATIONAL</div>
      <div className="client-grid">
        {MOCK_CLIENT_METRICS.map((m) => (
          <div className="client-metric" key={m.label}>
            <div className="label">{m.label}</div>
            <div className="value">{m.value}</div>
          </div>
        ))}
      </div>
      <div className="mock-note">Mock data — GHL/Meta client feed not wired yet</div>
    </HUDPanel>
  );
}
