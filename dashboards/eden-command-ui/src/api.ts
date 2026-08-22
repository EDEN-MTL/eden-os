const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
const DASHBOARD_KEY = import.meta.env.VITE_DASHBOARD_API_KEY || "";

export async function sendChatMessage(
  agentId: string,
  message: string,
  sessionId: string
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/chat/${agentId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(DASHBOARD_KEY ? { "x-dashboard-key": DASHBOARD_KEY } : {}),
    },
    body: JSON.stringify({ message, sessionId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  const data = await res.json();
  return data.reply as string;
}
