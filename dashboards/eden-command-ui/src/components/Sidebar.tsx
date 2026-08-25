import { AGENTS } from "../agents";

/**
 * Persistent left navigation.
 *
 * Replaces the top tab strip. The reason is not aesthetic: a sidebar can hold
 * the live agent roster alongside the nav, so the state of the system is
 * visible from every screen rather than only from the command view.
 */

export interface NavItem {
  id: string;
  label: string;
  icon: string;
}

/** Grouped so operational screens read apart from configuration. */
export const NAV_SECTIONS: { heading?: string; items: NavItem[] }[] = [
  {
    items: [
      { id: "COMMAND", label: "Command Center", icon: "◈" },
      { id: "AGENTS", label: "Agents", icon: "⬡" },
    ],
  },
  {
    heading: "Operations",
    items: [
      { id: "LEADS", label: "Lead Pipeline", icon: "⇄" },
      { id: "ISA", label: "AI ISA", icon: "◉" },
      { id: "ADS", label: "Ad Engine", icon: "◆" },
      { id: "CONTENT", label: "Content", icon: "✎" },
      { id: "INTEL", label: "Intel", icon: "▤" },
    ],
  },
  {
    heading: "Accounts",
    items: [
      { id: "CLIENTS", label: "Clients", icon: "▣" },
      { id: "SETTINGS", label: "Settings", icon: "⚙" },
    ],
  },
];

/**
 * Agent status is presentational for now — the roster is real, the live state
 * is not yet wired to anything. Only Scout and EDEN have implementations, so
 * showing eight agents as "working" would overstate what exists.
 */
function statusOf(agentId: string): "working" | "waiting" | "idle" {
  if (agentId === "eden") return "working";
  if (agentId === "scout") return "working";
  if (agentId === "iris") return "waiting";
  return "idle";
}

export default function Sidebar({
  activeTab,
  onTabChange,
  selectedAgent,
  onSelectAgent,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  selectedAgent: string;
  onSelectAgent: (code: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-mark">◆</div>
        <div>
          <div className="sidebar-brand-name">EDEN OS</div>
          <div className="sidebar-brand-sub">Agentic Growth Operations</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_SECTIONS.map((section, i) => (
          <div className="sidebar-section" key={section.heading || i}>
            {section.heading && <div className="sidebar-heading">{section.heading}</div>}
            {section.items.map((item) => (
              <button
                key={item.id}
                className={`sidebar-item${activeTab === item.id ? " active" : ""}`}
                onClick={() => onTabChange(item.id)}
              >
                <span className="sidebar-icon">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        ))}

        <div className="sidebar-section">
          <div className="sidebar-heading">Agents</div>
          {AGENTS.map((a) => {
            const status = statusOf(a.id);
            return (
              <button
                key={a.code}
                className={`sidebar-agent${selectedAgent === a.code ? " active" : ""}`}
                onClick={() => {
                  onSelectAgent(a.code);
                  onTabChange("AGENTS");
                }}
              >
                <span className="agent-swatch" style={{ background: a.color }} />
                <span className="sidebar-agent-text">
                  <span className="sidebar-agent-name">{a.name}</span>
                  <span className="sidebar-agent-role">{a.role}</span>
                </span>
                <span className={`status-pill ${status}`}>{status}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </aside>
  );
}
