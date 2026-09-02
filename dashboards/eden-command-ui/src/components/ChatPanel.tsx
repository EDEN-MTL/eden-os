import { ChangeEvent, useEffect, useRef, useState } from "react";
import { sendChatMessage, fetchSpeech, readAttachment } from "../api";
import { useVoicePlayer } from "../hooks/useVoicePlayer";
import { useSpeechInput } from "../hooks/useSpeechInput";
import { agentByCode } from "../agents";

interface ChatMessage {
  role: "user" | "agent" | "error";
  text: string;
  attachmentName?: string;
}

const SUGGESTIONS = ["System status", "Ad performance", "Brainstorm campaign", "Who needs attention?"];

const ACCEPTED_ATTACHMENT_TYPES = "image/png,image/jpeg,image/webp,image/gif,application/pdf";
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // matches server/chat-api.ts's decoded-size cap

const SESSION_STORAGE_KEY = "eden-chat-session-id";

/**
 * A random id would normally be fine to mint fresh per mount, but ChatPanel
 * only renders inside the COMMAND tab's own branch of App.tsx — switching to
 * any other tab and back unmounts and remounts it. A plain useRef() default
 * meant every tab switch (not just a real page reload) silently started a
 * brand-new history_key server-side, so the agent's actual memory (backed by
 * agent_conversations) never had a chance to be read back. Persisting the id
 * in localStorage keeps it the same across remounts, reloads, and restarts.
 */
function getOrCreateSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
  } catch {
    // localStorage unavailable (private browsing, blocked) — fall through
  }
  const fresh = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, fresh);
  } catch {
    // best effort — conversation just won't survive a remount this time
  }
  return fresh;
}

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
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionId = useRef(getOrCreateSessionId());
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
    const file = pendingFile;
    if ((!trimmed && !file) || pending) return;

    // A file with no caption still needs something to send as the turn's text.
    const messageText = trimmed || "Take a look at this.";

    setMessages((prev) => [...prev, { role: "user", text: messageText, attachmentName: file?.name }]);
    setInput("");
    setPendingFile(null);
    setPending(true);

    try {
      const attachment = file ? await readAttachment(file) : undefined;
      const reply = await sendChatMessage(agent.id, messageText, sessionId.current, attachment);
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

  function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file after removing it
    if (!file) return;

    if (file.size > MAX_ATTACHMENT_BYTES) {
      setMessages((prev) => [...prev, { role: "error", text: `${file.name} is over the 8MB attachment limit.` }]);
      return;
    }
    setExpanded(true);
    setPendingFile(file);
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
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_ATTACHMENT_TYPES}
        onChange={handleFileSelect}
        style={{ display: "none" }}
      />

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
                  <div className="message-body">
                    {m.text}
                    {m.attachmentName && <span className="message-attachment">📎 {m.attachmentName}</span>}
                  </div>
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

      {expanded && pendingFile && (
        <div className="attachment-chip">
          <span>📎 {pendingFile.name}</span>
          <button onClick={() => setPendingFile(null)} title="Remove attachment" aria-label="Remove attachment">
            ✕
          </button>
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
          <button className="attach-btn" onClick={() => fileInputRef.current?.click()} disabled={pending} title="Attach a file" aria-label="Attach a file">
            📎
          </button>
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
          <button className="transmit-btn" onClick={() => send(input)} disabled={pending || (!input.trim() && !pendingFile)}>
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
