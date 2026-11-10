import { useState } from "react";
import { setDashboardKey } from "../api";

/**
 * Shown when the server turns the page away (401). The key is typed here and kept in this browser only, so the hosted
 * page's code never contains it. `rejected` is true when a key was already tried and refused.
 */
export default function KeyPrompt({ rejected, onSaved }: { rejected: boolean; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function save(e: React.FormEvent) {
    e.preventDefault();
    const key = value.trim();
    if (!key) {
      setProblem("Paste the access key first.");
      return;
    }
    if (!setDashboardKey(key)) {
      setProblem("This browser would not store the key (private window?). Open the page in a normal window.");
      return;
    }
    setProblem(null);
    setValue("");
    onSaved();
  }

  return (
    <form className="lens-keyform" onSubmit={save} aria-labelledby="lens-key-title">
      <h2 id="lens-key-title" className="lens-h2">Enter the access key</h2>
      <p>
        {rejected ? "That key was not accepted. Check it and try again." : "This dashboard shows client data, so it needs the access key. Ask Mark if you don't have it."}
      </p>
      <label className="lens-label" htmlFor="lens-key-input">Access key</label>
      <div className="lens-keyrow">
        <input id="lens-key-input" className="lens-input" type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="lens-button is-primary">Open dashboard</button>
      </div>
      {problem && <div className="lens-hint" role="alert">{problem}</div>}
      <p className="lens-footnote">The key stays in this browser only. It is never written into the page.</p>
    </form>
  );
}
