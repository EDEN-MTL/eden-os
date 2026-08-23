const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
const DASHBOARD_KEY = import.meta.env.VITE_DASHBOARD_API_KEY || "";

function authHeaders(extra: Record<string, string> = {}) {
  return {
    ...extra,
    ...(DASHBOARD_KEY ? { "x-dashboard-key": DASHBOARD_KEY } : {}),
  };
}

export async function sendChatMessage(
  agentId: string,
  message: string,
  sessionId: string
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/chat/${agentId}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ message, sessionId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  const data = await res.json();
  return data.reply as string;
}

/**
 * Fetch EDEN's spoken audio for a line of text. Returns null (rather than
 * throwing) if TTS isn't configured server-side, so callers can silently
 * skip voice playback instead of erroring the whole chat flow.
 */
export async function fetchSpeech(text: string): Promise<Blob | null> {
  const res = await fetch(`${API_BASE}/api/tts`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ text }),
  });

  if (res.status === 501) return null;
  if (!res.ok) throw new Error(`TTS request failed: ${res.status}`);
  return res.blob();
}
