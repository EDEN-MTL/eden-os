import { AGENTS } from "../agents";

const MOCK_FEED = [
  { agent: "SCT", time: "2m ago", text: "3 leads captured — Coral Springs Meta campaign" },
  { agent: "IRS", time: "4m ago", text: "Warm transfer → Diaz. Brief: buyer $450k, pool home, 60 days" },
  { agent: "ATL", time: "5m ago", text: "Showing booked tomorrow 2pm — agent brief sent" },
  { agent: "EMB", time: "18m ago", text: "Reactivated cold lead — dormant 4 months" },
  { agent: "LNS", time: "30m ago", text: "Bottleneck flagged: Martinez follow-up 3x above avg" },
  { agent: "FRG", time: "1h ago", text: "Paused underperformer — CPL exceeded $35 threshold" },
];

export default function LiveFeedPanel() {
  const byCode = Object.fromEntries(AGENTS.map((a) => [a.code, a]));

  return (
    <div className="panel">
      <div className="panel-title-row">
        <span className="panel-title" style={{ marginBottom: 0 }}>
          LIVE OPERATIONS
        </span>
        <span className="live-tag">
          <span className="rec-dot" />
          REAL-TIME FEED
        </span>
      </div>
      <div className="feed-list">
        {MOCK_FEED.map((item, i) => {
          const agent = byCode[item.agent];
          return (
            <div className="feed-item" key={i}>
              <div className="feed-bar" style={{ background: agent.color, boxShadow: `0 0 10px 1px ${agent.color}99` }} />
              <div>
                <div className="feed-meta">
                  <span className="feed-agent" style={{ color: agent.color, textShadow: `0 0 10px ${agent.color}99` }}>
                    {agent.code}
                  </span>
                  <span className="feed-time">{item.time}</span>
                </div>
                <div className="feed-text">{item.text}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mock-note">Mock data — no live activity log wired yet</div>
    </div>
  );
}
