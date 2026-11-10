/**
 * Rescues a call where a real person said "Hello?" and Iris never answered.
 *
 * Soyemi Damilola, 2026-10-20 2:00 PM: she picked up and said a short hello about five
 * seconds in. Vapi's voice detector heard it, but the transcriber returned no words (a choppy
 * line), so Iris was never given a turn. She waits for the lead to speak first, by design (so
 * she never talks over a screener or voicemail), and the lead hung up after 22 seconds of
 * nothing. The same day a second call sat silent for 30 seconds.
 *
 * The rule here is narrow: ONE short burst of speech was heard, nothing was transcribed, Iris has
 * said nothing, and several seconds have passed. Then Iris says her opening line once, through Vapi's
 * live-call control. A screener, voicemail greeting or hold message always produces a
 * transcript, so none of those can trigger it. At most once per call.
 */

/**
 * How long after the lead stops speaking to wait for their words to show up before stepping in.
 * Vapi finalizes a transcript about 2 seconds after speech ends (1.5s endpointing plus processing),
 * so this leaves a wide margin: acting on a transcript that is merely late is how Iris once spoke
 * into a voicemail greeting (Sabrina Marie, 2026-10-21, one day after this feature shipped).
 */
export const RESCUE_DELAY_MS = 5000;

/**
 * The opening line, read back out of the call's own system prompt (the FIRST TURN block in
 * scripts.ts). Null for any call without that block (inbound, transfer legs), which are never
 * rescued: Iris speaks first on those anyway.
 */
export function openerFromPrompt(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  const m = prompt.match(/copied word for word, every word, nothing added, nothing dropped:\n\n(.+)\n\n/);
  return m ? m[1].trim() : null;
}

interface CallState {
  opener: string | null;
  controlUrl: string | null;
  userTranscripts: number;
  /** How many separate times the lead started speaking. A hello is ONE short burst; a greeting is two or more. */
  bursts: number;
  assistantSpoke: boolean;
  rescued: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RescueDeps {
  say: (controlUrl: string, content: string) => Promise<void>;
  /** Looks the call up on Vapi when its live messages didn't carry the control address or prompt. */
  fetchCall?: (id: string) => Promise<any | null>;
  delayMs?: number;
}

const defaultFetchCall = async (id: string): Promise<any | null> => {
  const key = process.env.VAPI_API_KEY;
  if (!key) return null;
  const res = await fetch(`https://api.vapi.ai/call/${id}`, { headers: { Authorization: `Bearer ${key}` } });
  return res.ok ? res.json() : null;
};

const defaultSay = async (controlUrl: string, content: string): Promise<void> => {
  const res = await fetch(controlUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "say", content, endCallAfterSpoken: false }) });
  if (!res.ok) throw new Error(`control ${res.status}`);
};

export function createHelloRescue(deps: RescueDeps = { say: defaultSay, fetchCall: defaultFetchCall }) {
  const calls = new Map<string, CallState>();
  const delay = deps.delayMs ?? RESCUE_DELAY_MS;

  function stateFor(message: any): { id: string; state: CallState } | null {
    const call = message?.call;
    const id = call?.id;
    if (!id) return null;
    let state = calls.get(id);
    if (!state) {
      const systemPrompt = (call.assistant?.model?.messages ?? []).find((m: any) => m?.role === "system")?.content;
      state = { opener: openerFromPrompt(systemPrompt), controlUrl: call.monitor?.controlUrl ?? null, userTranscripts: 0, bursts: 0, assistantSpoke: false, rescued: false, timer: null };
      calls.set(id, state);
    }
    if (!state.controlUrl && call.monitor?.controlUrl) state.controlUrl = call.monitor.controlUrl;
    return { id, state };
  }

  function clear(id: string): void {
    const s = calls.get(id);
    if (s?.timer) clearTimeout(s.timer);
    calls.delete(id);
  }

  /** Feed every Vapi server message through this; it ignores the ones it doesn't need. */
  function observe(message: any): void {
    const type = message?.type;
    if (type === "end-of-call-report" || (type === "status-update" && message.status === "ended")) {
      if (message?.call?.id) clear(message.call.id);
      return;
    }
    if (type !== "speech-update" && type !== "transcript" && type !== "conversation-update") return;
    const found = stateFor(message);
    if (!found) return;
    const { id, state } = found;

    if (type === "transcript") {
      if (message.role === "user") state.userTranscripts++;
      else if (message.role === "assistant" || message.role === "bot") state.assistantSpoke = true;
      return;
    }
    if (type === "conversation-update") {
      const msgs: any[] = message.conversation ?? message.messages ?? [];
      if (msgs.some((m) => m?.role === "assistant" && typeof m.content === "string" && m.content.trim() && m.content.trim() !== "[silent]")) state.assistantSpoke = true;
      // Vapi does not send "transcript" messages to us by default; the words reach us here, as a user
      // message in the conversation. Missing this is what let Iris speak into a voicemail greeting.
      if (msgs.some((m) => m?.role === "user" && typeof m.content === "string" && m.content.trim())) state.userTranscripts++;
      return;
    }
    // speech-update
    if (message.role === "assistant" && message.status === "started") {
      state.assistantSpoke = true;
      return;
    }
    if (message.role === "user" && message.status === "started") {
      state.bursts++;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      return;
    }
    if (message.role !== "user" || message.status !== "stopped" || state.rescued || state.assistantSpoke) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(async () => {
      state.timer = null;
      if (state.rescued || state.assistantSpoke || state.userTranscripts > 0 || state.bursts !== 1) return;
      if (!state.controlUrl || !state.opener) {
        const full = await deps.fetchCall?.(id).catch(() => null);
        const prompt = (full?.assistant?.model?.messages ?? []).find((m: any) => m?.role === "system")?.content;
        state.controlUrl = state.controlUrl ?? full?.monitor?.controlUrl ?? null;
        state.opener = state.opener ?? openerFromPrompt(prompt);
      }
      // Re-check after the lookup: the lead may have been heard, or the call ended, meanwhile.
      if (state.rescued || state.assistantSpoke || state.userTranscripts > 0 || state.bursts !== 1 || !state.controlUrl || !state.opener || !calls.has(id)) return;
      state.rescued = true;
      deps.say(state.controlUrl, state.opener).then(
        () => console.log(`[VAPI] Call ${id}: heard the lead speak but got no transcript — said the opener once.`),
        (error) => console.error(`[VAPI] Call ${id}: could not say the opener:`, error instanceof Error ? error.message : error)
      );
    }, delay);
  }

  return { observe, size: () => calls.size };
}

export const helloRescue = createHelloRescue({ say: defaultSay, fetchCall: defaultFetchCall });
