import { useRef, useState } from "react";
import { sendChatMessage } from "../api";

interface ChatMessage {
  role: "user" | "agent";
  text: string;
}

const SUGGESTIONS = ["System status", "Ad performance", "Brainstorm campaign", "Who needs attention?"];

export default function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setInput("");
    setPending(true);
    setError(null);

    try {
      const reply = await sendChatMessage("eden", trimmed, sessionId.current);
      setMessages((prev) => [...prev, { role: "agent", text: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reach EDEN");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="chat-column">
      <div className="chat-panel hud-panel">
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <div className="chat-eyebrow">EDEN INTELLIGENCE UPLINK</div>
            <div className="chat-divider" />
            <p>All systems operational. 8 agents reporting. Awaiting your command.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion-btn" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-log">
            {messages.map((m, i) => (
              <div className={`chat-msg ${m.role}`} key={i}>
                {m.role === "agent" && <span className="sender">◆ EDEN</span>}
                {m.text}
              </div>
            ))}
            {pending && <div className="chat-msg pending">◆ EDEN is responding...</div>}
            {error && (
              <div className="chat-msg agent" style={{ color: "#ff2255", borderLeftColor: "#ff2255" }}>
                {error}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="chat-input-bar">
        <span style={{ color: "var(--cyan)", fontSize: 14 }}>◆</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send(input);
          }}
          placeholder="Transmit a command to EDEN..."
          disabled={pending}
        />
        <button className="transmit-btn" onClick={() => send(input)} disabled={pending || !input.trim()}>
          TRANSMIT
        </button>
      </div>
    </div>
  );
}
