import { FormEvent, useEffect, useState } from "react";
import { getIntegrationsStatus, IntegrationsStatus, saveGhlCredentials, saveMetaCredentials } from "../api";

type SaveState = "idle" | "saving" | "success" | "error";

function IntegrationCard({
  title,
  configured,
  children,
}: {
  title: string;
  configured: boolean | null;
  children: React.ReactNode;
}) {
  return (
    <div className="panel glow module-metric-card" style={{ maxWidth: 520 }}>
      <div className="panel-title-row">
        <span className="panel-title" style={{ marginBottom: 0 }}>
          {title}
        </span>
        {configured !== null && (
          <span
            style={{
              fontSize: 11,
              letterSpacing: "0.14em",
              color: configured ? "#00ff88" : "rgba(255,60,90,.8)",
              textShadow: configured ? "0 0 8px rgba(0,255,136,.6)" : "none",
            }}
          >
            {configured ? "● CONFIGURED" : "○ NOT CONFIGURED"}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  required = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: "block", fontSize: 11.5, letterSpacing: "0.14em", color: "rgba(120,180,215,.6)", marginBottom: 5 }}>
        {label.toUpperCase()} {required && <span style={{ color: "#ff2255" }}>*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          background: "rgba(2,10,18,.7)",
          border: "1px solid rgba(0,184,255,.28)",
          color: "#e6f7ff",
          fontFamily: "var(--font-mono)",
          fontSize: 12.5,
          padding: "9px 12px",
        }}
      />
    </div>
  );
}

function SaveButton({ state }: { state: SaveState }) {
  const label = { idle: "SAVE & VERIFY", saving: "VERIFYING...", success: "✓ SAVED", error: "RETRY" }[state];
  return (
    <button
      type="submit"
      className="transmit-btn"
      disabled={state === "saving"}
      style={{ padding: "10px 20px", marginTop: 4 }}
    >
      {label}
    </button>
  );
}

export default function SettingsPage({
  clientId = "eden",
  clientName,
  onBack,
}: {
  clientId?: string;
  clientName?: string;
  onBack?: () => void;
}) {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);

  const [metaFields, setMetaFields] = useState({ appId: "", appSecret: "", accessToken: "", adAccountId: "", pageId: "" });
  const [metaState, setMetaState] = useState<SaveState>("idle");
  const [metaError, setMetaError] = useState<string | null>(null);

  const [ghlFields, setGhlFields] = useState({ apiKey: "", locationId: "", attributionPipelineName: "" });
  const [ghlState, setGhlState] = useState<SaveState>("idle");
  const [ghlError, setGhlError] = useState<string | null>(null);

  useEffect(() => {
    setStatus(null);
    getIntegrationsStatus(clientId).then(setStatus).catch(() => setStatus(null));
  }, [clientId]);

  async function submitMeta(e: FormEvent) {
    e.preventDefault();
    setMetaState("saving");
    setMetaError(null);
    try {
      await saveMetaCredentials(
        {
          ...metaFields,
          pageId: metaFields.pageId || undefined,
        },
        clientId
      );
      setMetaState("success");
      setMetaFields({ appId: "", appSecret: "", accessToken: "", adAccountId: "", pageId: "" });
      setStatus((s) => (s ? { ...s, meta: { configured: true } } : s));
    } catch (err) {
      setMetaState("error");
      setMetaError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  async function submitGhl(e: FormEvent) {
    e.preventDefault();
    setGhlState("saving");
    setGhlError(null);
    try {
      await saveGhlCredentials(
        {
          ...ghlFields,
          attributionPipelineName: ghlFields.attributionPipelineName || undefined,
        },
        clientId
      );
      setGhlState("success");
      setGhlFields({ apiKey: "", locationId: "", attributionPipelineName: "" });
      setStatus((s) => (s ? { ...s, ghl: { configured: true } } : s));
    } catch (err) {
      setGhlState("error");
      setGhlError(err instanceof Error ? err.message : "Failed to save");
    }
  }

  return (
    <div className="module-screen">
      <div className="module-inner">
        {onBack && (
          <button className="expand-btn" onClick={onBack} style={{ marginBottom: 16 }}>
            ← BACK
          </button>
        )}
        <div className="module-eyebrow">{clientName ? `${clientName.toUpperCase()} · INTEGRATIONS` : "FORGE · INTEGRATIONS"}</div>
        <div className="module-title">SETTINGS</div>
        <div className="module-title-line" />

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <IntegrationCard title="META ADS" configured={status?.meta.configured ?? null}>
            <form onSubmit={submitMeta}>
              <Field label="App ID" value={metaFields.appId} onChange={(v) => setMetaFields((f) => ({ ...f, appId: v }))} />
              <Field
                label="App Secret"
                type="password"
                value={metaFields.appSecret}
                onChange={(v) => setMetaFields((f) => ({ ...f, appSecret: v }))}
              />
              <Field
                label="Access Token"
                type="password"
                value={metaFields.accessToken}
                onChange={(v) => setMetaFields((f) => ({ ...f, accessToken: v }))}
              />
              <Field
                label="Ad Account ID"
                value={metaFields.adAccountId}
                onChange={(v) => setMetaFields((f) => ({ ...f, adAccountId: v }))}
                placeholder="act_..."
              />
              <Field
                label="Page ID"
                value={metaFields.pageId}
                onChange={(v) => setMetaFields((f) => ({ ...f, pageId: v }))}
                placeholder="Optional — needed for ad creatives"
                required={false}
              />
              {metaError && (
                <div style={{ color: "#ff2255", fontSize: 11.5, marginBottom: 10 }}>{metaError}</div>
              )}
              <SaveButton state={metaState} />
            </form>
          </IntegrationCard>

          <IntegrationCard title="GOHIGHLEVEL" configured={status?.ghl.configured ?? null}>
            <form onSubmit={submitGhl}>
              <Field
                label="API Key"
                type="password"
                value={ghlFields.apiKey}
                onChange={(v) => setGhlFields((f) => ({ ...f, apiKey: v }))}
              />
              <Field
                label="Location ID"
                value={ghlFields.locationId}
                onChange={(v) => setGhlFields((f) => ({ ...f, locationId: v }))}
              />
              <Field
                label="Attribution Pipeline Name"
                value={ghlFields.attributionPipelineName}
                onChange={(v) => setGhlFields((f) => ({ ...f, attributionPipelineName: v }))}
                placeholder="Optional — leave blank to consider all pipelines"
                required={false}
              />
              {ghlError && <div style={{ color: "#ff2255", fontSize: 11.5, marginBottom: 10 }}>{ghlError}</div>}
              <SaveButton state={ghlState} />
            </form>
          </IntegrationCard>
        </div>

        <div className="mock-note" style={{ marginTop: 24 }}>
          Credentials are validated against the real API before saving and are never shown again after saving —
          this page only ever reports configured / not configured.
        </div>
      </div>
    </div>
  );
}
