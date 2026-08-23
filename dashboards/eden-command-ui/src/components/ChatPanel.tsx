import { useEffect, useRef, useState } from "react";
import { sendChatMessage, fetchSpeech } from "../api";
import { useVoicePlayer } from "../hooks/useVoicePlayer";
import { useSpeechInput } from "../hooks/useSpeechInput";

interface ChatMessage {
  role: "user" | "agent" | "error";
  text: string;
}

const SUGGESTIONS = ["System status", "Ad performance", "Brainstorm campaign", "Who needs attention?"];

export default function ChatPanel({
  onVoiceLevelChange,
}: {
  onVoiceLevelChange: (level: number) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const sessionId = useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const { play, level, speaking } = useVoicePlayer();

  useEffect(() => onVoiceLevelChange(level), [level, onVoiceLevelChange]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setInput("");
    setPending(true);

    try {
      const reply = await sendChatMessage("eden", trimmed, sessionId.current);
      setMessages((prev) => [...prev, { role: "agent", text: reply }]);
      setPending(false);

      const audio = await fetchSpeech(reply).catch(() => null);
      if (audio) await play(audio);
    } catch (err) {
      setPending(false);
      const msg = err instanceof Error ? err.message : "Failed to reach EDEN";
      setMessages((prev) => [...prev, { role: "error", text: msg }]);
    }
  }

  const { start: startListening, listening, supported: micSupported } = useSpeechInput((transcript) => {
    send(transcript);
  });

  return (
    <>
      <div className="chat-scroll">
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <div className="chat-eyebrow">EDEN INTELLIGENCE UPLINK</div>
            <div className="chat-divider" />
            <div className="chat-welcome-text">
              All systems operational. 8 agents reporting.
              <br />
              Awaiting your command.
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion-btn" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="messages">
            {messages.map((m, i) => (
              <div className={`message ${m.role === "user" ? "user" : m.role === "error" ? "agent error" : "agent"}`} key={i}>
                <div className="message-label">{m.role === "user" ? "OPERATOR" : "◆ EDEN"}</div>
                <div className="message-body">{m.text}</div>
              </div>
            ))}
            {pending && (
              <div className="message agent pending">
                <div className="message-label">◆ EDEN</div>
                <div className="message-body">Processing...</div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="transmit-bar">
        <div className="transmit-icon">
          <span style={{ width: 10, height: 10, transform: "rotate(45deg)", background: "linear-gradient(135deg,#00fff2,#00b8ff)", boxShadow: "0 0 12px 2px rgba(0,184,255,.8)", display: "block" }} />
        </div>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send(input);
          }}
          placeholder="Issue a command to EDEN…"
          disabled={pending}
        />
        {speaking && <span className="speaking-indicator">◆ SPEAKING</span>}
        {micSupported && (
          <button
            className={`mic-btn ${listening ? "listening" : ""}`}
            onClick={startListening}
            disabled={pending || listening}
            title="Talk to EDEN"
          >
            {listening ? "●" : "🎙"}
          </button>
        )}
        <button className="transmit-btn" onClick={() => send(input)} disabled={pending || !input.trim()}>
          TRANSMIT
        </button>
      </div>
    </>
  );
}
