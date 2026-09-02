import { FormEvent, useEffect, useState } from "react";
import { ClientSummary, createClient, getClients } from "../api";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Onboarding a client used to mean hand-creating config/clients/<id>.json
 * on the server's filesystem, then hitting the settings API directly for
 * credentials since the dashboard had no picker for anything but "eden".
 * This closes that loop: create the config file here, then land straight
 * on that client's page where "⚙ CONFIGURE CREDENTIALS" is one click away.
 */
function AddClientForm({
  onCreated,
  onCancel,
}: {
  onCreated: (clientId: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [industry, setIndustry] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleNameChange(v: string) {
    setName(v);
    if (!idTouched) setId(slugify(v));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await createClient({ clientId: id, clientName: name.trim(), industry: industry.trim() || undefined });
      onCreated(id);
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : "Failed to create client");
    }
  }

  return (
    <form onSubmit={submit} className="panel glow" style={{ padding: 20, marginBottom: 20, maxWidth: 480 }}>
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: "block", fontSize: 11.5, letterSpacing: "0.14em", color: "rgba(120,180,215,.6)", marginBottom: 5 }}>
          CLIENT NAME <span style={{ color: "#ff2255" }}>*</span>
        </label>
        <input value={name} onChange={(e) => handleNameChange(e.target.value)} placeholder="Acme Realty" style={{ width: "100%" }} autoFocus />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: "block", fontSize: 11.5, letterSpacing: "0.14em", color: "rgba(120,180,215,.6)", marginBottom: 5 }}>
          CLIENT ID <span style={{ color: "#ff2255" }}>*</span>
        </label>
        <input
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setIdTouched(true);
          }}
          placeholder="acme-realty"
          style={{ width: "100%" }}
        />
        <div style={{ fontSize: 10.5, color: "rgba(120,180,215,.5)", marginTop: 4 }}>
          Lowercase letters, numbers, and hyphens only — becomes config/clients/{id || "…"}.json
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: "block", fontSize: 11.5, letterSpacing: "0.14em", color: "rgba(120,180,215,.6)", marginBottom: 5 }}>
          INDUSTRY
        </label>
        <input value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Optional" style={{ width: "100%" }} />
      </div>
      {error && <div style={{ color: "#ff2255", fontSize: 11.5, marginBottom: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="transmit-btn" disabled={saving || !name.trim() || !id.trim()} style={{ padding: "10px 20px" }}>
          {saving ? "CREATING..." : "CREATE CLIENT"}
        </button>
        <button type="button" className="expand-btn" onClick={onCancel} disabled={saving}>
          CANCEL
        </button>
      </div>
    </form>
  );
}

export default function ClientsListPage({ onSelectClient }: { onSelectClient: (clientId: string) => void }) {
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slowLoad, setSlowLoad] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    const slowTimer = setTimeout(() => setSlowLoad(true), 3000);
    getClients()
      .then(setClients)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load clients"))
      .finally(() => clearTimeout(slowTimer));
    return () => clearTimeout(slowTimer);
  }, []);

  return (
    <div className="module-screen">
      <div className="module-inner">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="module-eyebrow">NOVA · CLIENT MANAGEMENT</div>
            <div className="module-title">CLIENTS</div>
          </div>
          {!showAddForm && (
            <button className="expand-btn" onClick={() => setShowAddForm(true)}>
              ＋ ADD CLIENT
            </button>
          )}
        </div>
        <div className="module-title-line" />

        {showAddForm && (
          <AddClientForm
            onCancel={() => setShowAddForm(false)}
            onCreated={(clientId) => {
              setShowAddForm(false);
              // Jump straight into the new client's page rather than back to
              // the list — "⚙ CONFIGURE CREDENTIALS" is one click from there,
              // which is the very next thing anyone creating a client needs.
              onSelectClient(clientId);
            }}
          />
        )}

        {error && <div style={{ color: "#ff2255", fontSize: 12 }}>{error}</div>}

        {/*
          The backend runs on a Render plan that sleeps when idle, so the
          first request after a quiet period can take ~50s to wake it.
          Without this the page renders empty during that window and looks
          broken. The explanation line only appears once the wait is long
          enough to actually be a cold start, so a normal fast load doesn't
          show a misleading "waking up" message.
        */}
        {!clients && !error && (
          <div className="mock-note" style={{ fontSize: 11 }}>
            Loading clients…
            {slowLoad && (
              <div style={{ marginTop: 6 }}>
                The backend sleeps when idle — waking it up can take up to a minute.
              </div>
            )}
          </div>
        )}

        {clients && clients.length === 0 && !showAddForm && (
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
