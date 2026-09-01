import { useEffect, useRef, useState } from "react";
import { sendChatMessage, fetchSpeech } from "../api";
import { useVoicePlayer } from "../hooks/useVoicePlayer";
import { useSpeechInput } from "../hooks/useSpeechInput";
import { agentByCode } from "../agents";

interface ChatMessage {
  role: "user" | "agent" | "error";
  text: string;
}

const SUGGESTIONS = ["System status", "Ad performance", "Brainstorm campaign", "Who needs attention?"];

export default function ChatPanel({
  selectedAgent,
  onVoiceLevelChange,
}: {
  selectedAgent: string;
  onVoiceLevelChange: (level: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const sessionId = useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const { play, stop, level, speaking } = useVoicePlayer();
  const agent = agentByCode(selectedAgent);

  useEffect(() => onVoiceLevelChange(level), [level, onVoiceLevelChange]);

  // Switching who you're talking to starts a fresh conversation — a reply
  // from Forge answering a question you asked Scout would be confusing, and
  // each agent's own history lives server-side keyed by session anyway.
  useEffect(() => {
    setMessages([]);
  }, [agent.id]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setInput("");
    setPending(true);

    try {
      const reply = await sendChatMessage(agent.id, trimmed, sessionId.current);
      setMessages((prev) => [...prev, { role: "agent", text: reply }]);
      setPending(false);

      const audio = await fetchSpeech(reply).catch(() => null);
      if (audio) {
        await play(audio);
        // EDEN just finished talking — listen for the reply automatically
        // instead of making the user click the mic again. Only happens
        // when there was actually spoken audio (a typed-only exchange
        // with no TTS configured doesn't trigger this).
        startListening();
      }
    } catch (err) {
      setPending(false);
      const msg = err instanceof Error ? err.message : `Failed to reach ${agent.name}`;
      setMessages((prev) => [...prev, { role: "error", text: msg }]);
    }
  }

  const {
    start: startListening,
    stop: stopListening,
    cancel: cancelListening,
    listening,
    supported: micSupported,
  } = useSpeechInput((transcript) => {
    setExpanded(true);
    send(transcript);
  });

  function toggleMic() {
    if (listening) stopListening();
    else startListening();
  }

  return (
    <>
      {expanded && (
        <div className="chat-scroll">
          {messages.length === 0 ? (
            <div className="chat-welcome">
              <div className="chat-eyebrow">{agent.name.toUpperCase()} UPLINK</div>
              <div className="chat-divider" />
              <div className="chat-welcome-text">
                {agent.id === "eden" ? (
                  <>
                    All systems operational. 8 agents reporting.
                    <br />
                    Awaiting your command.
                  </>
                ) : (
                  agent.role
                )}
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
                  <div className="message-label">{m.role === "user" ? "OPERATOR" : `◆ ${agent.name.toUpperCase()}`}</div>
                  <div className="message-body">{m.text}</div>
                </div>
              ))}
              {pending && (
                <div className="message agent pending">
                  <div className="message-label">◆ {agent.name.toUpperCase()}</div>
                  <div className="message-body">Processing...</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {expanded ? (
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
            placeholder={`Issue a command to ${agent.name}…`}
            disabled={pending}
          />
          {speaking && (
            <>
              <span className="speaking-indicator">◆ SPEAKING</span>
              <button
                className="stop-btn"
                onClick={stop}
                title={`Stop ${agent.name} talking`}
                aria-label="Stop speaking"
              >
                ■ STOP
              </button>
            </>
          )}
          {micSupported && (
            <button className={`mic-btn ${listening ? "listening" : ""}`} onClick={toggleMic} disabled={pending} title={`Talk to ${agent.name}`}>
              {listening ? "●" : "🎙"}
            </button>
          )}
          {micSupported && listening && (
            <button className="mic-cancel-btn" onClick={cancelListening} title="Cancel recording" aria-label="Cancel recording">
              ✕
            </button>
          )}
          <button className="transmit-btn" onClick={() => send(input)} disabled={pending || !input.trim()}>
            TRANSMIT
          </button>
          <button className="collapse-btn" onClick={() => setExpanded(false)} title="Hide chat">
            ▾
          </button>
        </div>
      ) : (
        <div className="voice-bar">
          {micSupported && (
            <button className={`mic-btn-lg ${listening ? "listening" : ""}`} onClick={toggleMic} disabled={pending} title={`Talk to ${agent.name}`}>
              {listening ? "●" : "🎙"}
            </button>
          )}
          {micSupported && listening && (
            <button className="mic-cancel-btn" onClick={cancelListening} title="Cancel recording" aria-label="Cancel recording">
              ✕
            </button>
          )}
          {speaking && (
            <>
              <span className="speaking-indicator">◆ SPEAKING</span>
              <button
                className="stop-btn"
                onClick={stop}
                title={`Stop ${agent.name} talking`}
                aria-label="Stop speaking"
              >
                ■ STOP
              </button>
            </>
          )}
          <button className="expand-btn" onClick={() => setExpanded(true)} title="Open chat">
            💬 CHAT
          </button>
        </div>
      )}
    </>
  );
}
