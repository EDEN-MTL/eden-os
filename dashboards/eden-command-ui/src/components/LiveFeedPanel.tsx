import { AGENTS } from "../agents";
import HUDPanel from "./HUDPanel";

// Placeholder feed — no real event log persistence exists yet.
// Swap for a real feed once agent activity is logged somewhere queryable.
const MOCK_FEED = [
  { agentId: "scout", time: "2m ago", text: "3 leads captured — Coral Springs Meta campaign" },
  { agentId: "iris", time: "4m ago", text: "Warm transfer → Diaz. Brief: buyer $450k, pool home, 60 days" },
  { agentId: "atlas", time: "5m ago", text: "Showing booked tomorrow 2pm — agent brief sent" },
  { agentId: "ember", time: "18m ago", text: "Reactivated cold lead — dormant 4 months" },
  { agentId: "lens", time: "30m ago", text: "Bottleneck flagged: Martinez follow-up 3x above avg" },
  { agentId: "forge", time: "1h ago", text: "Paused underperformer — CPL exceeded $35 threshold" },
];

export default function LiveFeedPanel() {
  const agentById = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

  return (
    <HUDPanel title="LIVE OPERATIONS">
      <div className="feed-header">
        <span className="rec-dot" />
        <span style={{ fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.1em" }}>
          REAL-TIME FEED
        </span>
      </div>
      {MOCK_FEED.map((item, i) => {
        const agent = agentById[item.agentId];
        return (
          <div className="feed-item" key={i}>
            <div className="feed-bar" style={{ background: agent?.color }} />
            <div className="feed-body">
              <div className="feed-meta">
                <span className="feed-agent-code" style={{ color: agent?.color }}>
                  {agent?.code}
                </span>
                <span>{item.time}</span>
              </div>
              <div className="feed-text">{item.text}</div>
            </div>
          </div>
        );
      })}
      <div className="mock-note">Mock data — no live activity log wired yet</div>
    </HUDPanel>
  );
}
