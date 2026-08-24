import { useEffect, useState } from "react";
import { ClientSummary, getClients } from "../api";

export default function ClientsListPage({ onSelectClient }: { onSelectClient: (clientId: string) => void }) {
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getClients()
      .then(setClients)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load clients"));
  }, []);

  return (
    <div className="module-screen">
      <div className="module-inner">
        <div className="module-eyebrow">NOVA · CLIENT MANAGEMENT</div>
        <div className="module-title">CLIENTS</div>
        <div className="module-title-line" />

        {error && <div style={{ color: "#ff2255", fontSize: 12 }}>{error}</div>}

        {clients && clients.length === 0 && (
          <div className="mock-note" style={{ fontSize: 11 }}>
            No client configs found in config/clients/*.json yet.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {clients?.map((c) => (
            <button
              key={c.clientId}
              className="panel glow"
              style={{
                textAlign: "left",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
                appearance: "none",
                color: "inherit",
              }}
              onClick={() => onSelectClient(c.clientId)}
            >
              <div>
                <div className="client-name">{c.clientName.toUpperCase()}</div>
                <div className="client-status" style={{ color: c.configured ? "#00ff88" : "rgba(255,60,90,.8)" }}>
                  <span
                    className="status-dot"
                    style={{ background: c.configured ? "#00ff88" : "#ff2255", boxShadow: c.configured ? undefined : "0 0 10px 2px rgba(255,34,85,.8)" }}
                  />
                  {c.configured ? "OPERATIONAL" : "NOT FULLY CONFIGURED"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 24 }}>
                <div>
                  <div className="dossier-task-label">SPEND (30D)</div>
                  <div className="module-metric-value" style={{ fontSize: 20, color: "#ffa800" }}>
                    ${c.spendLast30d.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="dossier-task-label">LEADS (30D)</div>
                  <div className="module-metric-value" style={{ fontSize: 20, color: "#00b8ff" }}>
                    {c.leadsLast30d}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
