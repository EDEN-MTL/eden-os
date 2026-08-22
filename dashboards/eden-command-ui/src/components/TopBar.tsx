import { useEffect, useState } from "react";

const TABS = ["COMMAND", "LEADS", "ISA", "ADS", "CONTENT", "INTEL", "CLIENTS"];

export default function TopBar() {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="logo-diamond" />
        <span className="brand">
          EDEN <span className="brand-version">OS v0.1</span>
        </span>
      </div>
      <div className="topbar-nav">
        {TABS.map((tab, i) => (
          <span key={tab} className={i === 0 ? "active" : ""}>
            {tab}
          </span>
        ))}
      </div>
      <div className="topbar-right">
        <span className="pulse-dot" />
        <span>SYSTEMS NOMINAL</span>
        <span>{time.toLocaleTimeString()}</span>
      </div>
    </div>
  );
}
