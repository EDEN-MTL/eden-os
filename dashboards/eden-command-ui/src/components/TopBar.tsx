import { useEffect, useState } from "react";
import { TABS } from "../modules";

export default function TopBar({
  activeTab,
  onTabChange,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
}) {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const clock = time.toTimeString().slice(0, 8);

  return (
    <div className="topbar">
      <div className="brand-group">
        <span className="logo-diamond" />
        <span className="brand">
          EDEN <span className="brand-version">OS v0.1</span>
        </span>
      </div>
      <div className="tab-nav">
        {TABS.map((tab) => (
          <button
            key={tab}
            className={`tab-btn ${tab === activeTab ? "active" : ""}`}
            onClick={() => onTabChange(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="topbar-right">
        <span className="status-dot" />
        <span>SYSTEMS NOMINAL</span>
        <span className="clock">{clock}</span>
      </div>
    </div>
  );
}
