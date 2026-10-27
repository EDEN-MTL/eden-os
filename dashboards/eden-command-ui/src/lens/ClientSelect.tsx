import { useEffect, useMemo, useRef, useState } from "react";
import type { LensClient } from "./types";

/** A searchable list of clients: type to filter, arrow keys and Enter to pick, Escape to close. */
export default function ClientSelect({ clients, value, onChange }: { clients: LensClient[]; value: string | null; onChange: (clientId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const selected = clients.find((c) => c.clientId === value) ?? null;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? clients.filter((c) => c.name.toLowerCase().includes(q) || c.clientId.includes(q)) : clients;
  }, [clients, filter]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function pick(c: LensClient) {
    onChange(c.clientId);
    setOpen(false);
    setFilter("");
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && shown[active]) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "Escape") setOpen(false);
  }

  return (
    <div className="lens-field lens-client" ref={root}>
      <label className="lens-label" id="lens-client-label">Client</label>
      <button
        type="button"
        className="lens-select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby="lens-client-label"
        onClick={() => {
          setOpen((o) => !o);
          setActive(Math.max(0, clients.findIndex((c) => c.clientId === value)));
        }}
      >
        <span>{selected ? selected.name : "Choose a client"}</span>
        <span aria-hidden="true" className="lens-caret">▾</span>
      </button>
      {open && (
        <div className="lens-popover" role="presentation">
          <input
            ref={input}
            className="lens-input"
            placeholder="Search clients"
            aria-label="Search clients"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          <ul role="listbox" aria-label="Clients" className="lens-options">
            {shown.length === 0 && <li className="lens-option lens-option-empty">No client matches "{filter}"</li>}
            {shown.map((c, i) => (
              <li
                key={c.clientId}
                role="option"
                aria-selected={c.clientId === value}
                className={`lens-option${i === active ? " is-active" : ""}${c.clientId === value ? " is-selected" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(c)}
              >
                <span>{c.name}</span>
                {c.missing.length > 0 && <span className="lens-option-flag" title={c.missing.join("\n")}>incomplete</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
