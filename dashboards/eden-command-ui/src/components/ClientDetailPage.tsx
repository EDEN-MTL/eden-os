import { useCallback, useEffect, useState } from "react";
import { ClientDetail, decidePendingAction, getClientDetail } from "../api";
import SettingsPage from "./SettingsPage";

/** Both decimals always — "$25,498.5" reads like a truncated number. */
const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function StatusBadge({ configured, label }: { configured: boolean; label: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        letterSpacing: "0.12em",
        color: configured ? "#00ff88" : "rgba(255,60,90,.8)",
        border: `1px solid ${configured ? "rgba(0,255,136,.4)" : "rgba(255,34,85,.4)"}`,
        padding: "3px 8px",
      }}
    >
      {label} {configured ? "● CONNECTED" : "○ NOT CONFIGURED"}
    </span>
  );
}

export default function ClientDetailPage({ clientId, onBack }: { clientId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(() => {
    getClientDetail(clientId)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load client"));
  }, [clientId]);

  useEffect(() => {
    setDetail(null);
    load();
  }, [load]);

  async function decide(id: number, decision: "approve" | "reject") {
    setDecidingId(id);
    try {
      await decidePendingAction(clientId, id, decision);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${decision}`);
    } finally {
      setDecidingId(null);
    }
  }

  if (error && !detail) {
    return (
      <div className="module-screen">
        <div className="module-inner">
          <button className="expand-btn" onClick={onBack} style={{ marginBottom: 16 }}>
            ← BACK TO CLIENTS
          </button>
          <div style={{ color: "#ff2255" }}>{error}</div>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="module-screen">
        <div className="module-inner">
          <div className="module-eyebrow">LOADING...</div>
        </div>
      </div>
    );
  }

  if (showSettings) {
    return (
      <SettingsPage
        clientId={clientId}
        clientName={detail.clientName}
        onBack={() => {
          setShowSettings(false);
          load();
        }}
      />
    );
  }

  return (
    <div className="module-screen">
      <div className="module-inner">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <button className="expand-btn" onClick={onBack} style={{ marginBottom: 16 }}>
            ← BACK TO CLIENTS
          </button>
          <button className="expand-btn" onClick={() => setShowSettings(true)} style={{ marginBottom: 16 }}>
            ⚙ CONFIGURE CREDENTIALS
          </button>
        </div>
        <div className="module-eyebrow">CLIENT</div>
        <div className="module-title">{detail.clientName.toUpperCase()}</div>
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <StatusBadge configured={detail.metaConfigured} label="META" />
          <StatusBadge configured={detail.ghlConfigured} label="GHL" />
        </div>
        <div className="module-title-line" />

        {error && <div style={{ color: "#ff2255", fontSize: 12, marginBottom: 16 }}>{error}</div>}

        {/* Banked vs committed. Jacob was explicit that stages like "Buyer
            Confirmed" are pipeline value, not revenue — so they are shown
            side by side and never summed into one headline number. */}
        {detail.crmPipeline && (
          <div className="panel" style={{ marginBottom: 18 }}>
            <div className="panel-title">PIPELINE · WHOLE CRM</div>
            <div style={{ display: "flex", gap: 40, flexWrap: "wrap", marginTop: 10 }}>
              <div>
                <div className="metric-label">REVENUE · BANKED</div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 24, color: "#00ff88" }}>
                  ${money(detail.crmPipeline.revenue)}
                </div>
                <div className="mock-note">{detail.crmPipeline.wonCount} closed</div>
              </div>
              <div>
                <div className="metric-label">PIPELINE · COMMITTED</div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 24, color: "#00b8ff" }}>
                  ${money(detail.crmPipeline.pipelineValue)}
                </div>
                <div className="mock-note">{detail.crmPipeline.activeCount} in flight, not yet closed</div>
              </div>
            </div>
            <div className="mock-note" style={{ marginTop: 10 }}>
              Whole-CRM totals, not ad-attributed — no lead carries ad attribution yet.
            </div>
          </div>
        )}

        <div className="module-body-grid">
          {/* Ad performance + pending approvals */}
          <div className="panel">
            <div className="panel-title-row">
              <span className="panel-title" style={{ marginBottom: 0 }}>
                AD PERFORMANCE · LAST 30D
              </span>
            </div>
            {detail.adPerformance.length === 0 ? (
              <div className="mock-note" style={{ fontSize: 11 }}>
                No Meta performance data synced yet{!detail.metaConfigured && " — Meta isn't configured for this client"}.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {detail.adPerformance.slice(0, 8).map((row) => (
                  <div key={row.ad_id} style={{ borderBottom: "1px solid rgba(0,184,255,.12)", paddingBottom: 8 }}>
                    <div style={{ fontSize: 11.5, color: "rgba(200,232,250,.85)" }}>{row.ad_name || row.ad_id}</div>
                    <div style={{ display: "flex", gap: 16, fontSize: 12.5, color: "rgba(140,195,225,.6)", marginTop: 3 }}>
                      <span>spend ${row.spend.toFixed(2)}</span>
                      <span>leads {row.lead_count}</span>
                      <span>CPL {row.cpl !== null ? `$${row.cpl}` : "—"}</span>
                      <span>ROAS {row.roas !== null ? `${row.roas}x` : "—"}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="panel-title" style={{ marginTop: 20 }}>
              PENDING APPROVAL
            </div>
            {detail.pendingActions.length === 0 ? (
              <div className="mock-note" style={{ fontSize: 11 }}>
                Nothing awaiting approval right now.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {detail.pendingActions.map((action) => (
                  <div key={action.id} className="panel" style={{ padding: "10px 12px" }}>
                    <div style={{ fontSize: 11, color: "var(--cyan)", marginBottom: 4 }}>
                      {action.rule_name} — {action.action_type.toUpperCase()} {action.entity_type}{" "}
                      {action.entity_name || action.entity_id}
                    </div>
                    <div style={{ fontSize: 12.5, color: "rgba(198,230,248,.72)", marginBottom: 8 }}>{action.reasoning}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        className="transmit-btn"
                        style={{ padding: "6px 14px", fontSize: 12 }}
                        disabled={decidingId === action.id}
                        onClick={() => decide(action.id, "approve")}
                      >
                        {decidingId === action.id ? "..." : "APPROVE"}
                      </button>
                      <button
                        className="mic-btn"
                        style={{ width: "auto", padding: "6px 14px", fontSize: 12, border: "1px solid rgba(255,34,85,.4)", color: "#ff2255" }}
                        disabled={decidingId === action.id}
                        onClick={() => decide(action.id, "reject")}
                      >
                        REJECT
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Pipeline / leads + appointments */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div className="panel">
              <div className="panel-title">RECENT LEADS (GHL)</div>
              {detail.recentLeads.length === 0 ? (
                <div className="mock-note" style={{ fontSize: 11 }}>
                  No leads synced yet{!detail.ghlConfigured && " — GHL isn't configured for this client"}.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {detail.recentLeads.map((lead) => (
                    <div key={lead.id} style={{ borderLeft: "2px solid #00b8ff", paddingLeft: 10 }}>
                      <div style={{ fontSize: 11, color: "rgba(200,232,250,.85)" }}>{lead.pipeline_stage || "New"}</div>
                      <div style={{ fontSize: 12, color: "rgba(120,180,215,.5)" }}>
                        {new Date(lead.created_at).toLocaleDateString()}
                        {lead.won === true && " · WON"}
                        {lead.won === false && " · LOST"}
                        {lead.deal_value ? ` · $${lead.deal_value}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="panel">
              <div className="panel-title">APPOINTMENTS</div>
              <div className="mock-note" style={{ fontSize: 11 }}>
                {detail.appointments.reason || "Not available yet."}
              </div>
            </div>

            {detail.forgeRules && (
              <div className="panel">
                <div className="panel-title">FORGE RULES CONFIG</div>
                <div style={{ fontSize: 11, color: "rgba(198,230,248,.72)", lineHeight: 1.8 }}>
                  CPL threshold: ${detail.forgeRules.cplThreshold}
                  <br />
                  ROAS target: {detail.forgeRules.roasTarget}x
                  <br />
                  Daily budget cap: ${detail.forgeRules.dailyBudgetCap}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
