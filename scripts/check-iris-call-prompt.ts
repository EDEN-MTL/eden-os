/**
 * Checks how the REAL outbound Iris prompt behaves, turn by turn, through Vapi's
 * text chat — the same model and prompt a live call uses, minus voice. No phone
 * call, no minutes, a few cents of model tokens. Run it BEFORE shipping any
 * change to the call prompt (agents/iris/scripts.ts, calling.ts):
 *
 *   npx tsx --env-file=.env scripts/check-iris-call-prompt.ts        (N=12 per case; ONLY=opener to run just the opener cases)
 *
 * Every case should score N/N. Added 2026-10-14 after a prompt change shipped
 * untested and left two real people saying "Hello?" to silence. Voice-only
 * behavior (the transcriber, the voice, the replacements in calling.ts that strip
 * "[silent]" and a lone "Goodbye.") is NOT covered here.
 */
import { buildCallPayload } from "../agents/iris/calling";
import { buildLeadQualificationPrompt } from "../agents/iris/scripts";
import { loadIrisConfig, loadClientBranding } from "../agents/iris";
const key = process.env.VAPI_API_KEY!;
const cfg: any = { apiKey: key, phoneNumberId: "x", modelProvider: process.env.VAPI_MODEL_PROVIDER, modelName: process.env.VAPI_MODEL_NAME, voiceProvider: process.env.VAPI_VOICE_PROVIDER, voiceId: process.env.VAPI_VOICE_ID, serverUrl: "https://eden-os.onrender.com/webhooks/vapi", webhookSecret: "s" };
const iris = loadIrisConfig("3-percent-east-coast")!; const br = loadClientBranding("3-percent-east-coast")!;
const lead: any = { name: "Amanda Test", email: null, phone: "+15555550100", intent: "buyer", score: 50, budget: "$300K-$600K", timeline: "ASAP", leadSource: "Facebook", contactId: "zz", scoreReasons: [], qualified: false, firstTouch: true, attributed: false, attribution: {}, preApproved: null, financing: null, bedrooms: null, propertyInterest: null, workingWithRealtor: false, sources: {} };
let prompt = buildLeadQualificationPrompt(iris, lead, br.brandName, br.city, true, true, true);
const p: any = buildCallPayload({ clientId: "3-percent-east-coast", brandName: br.brandName, city: br.city, phone: lead.phone, firstName: "Amanda", intent: "buyer", leadSource: "Facebook", systemPrompt: prompt, contactId: "zz", triggeredBy: "manual" } as any, cfg);
const assistant = { name: "zz-chat-test", model: p.assistant.model, firstMessageMode: "assistant-waits-for-user" };
const OPENER = "Hi, this is Iris with 3 Percent East Coast. Am I speaking with Amanda?";
/** Digits a voice reads one by one, a $ on a figure, or a currency that isn't ours — never acceptable in anything Iris says. */
const SPOKEN_FIGURE_PROBLEM = /\d{5,}|(?:\d ){3,}\d|\$\s?\d|\b(?:euros?|pounds|pesos)\b|[€£]/i;
async function turn(history: { role: string; content: string }[], input: string): Promise<string> {
  const msgs = [...history, { role: "user", content: input }];
  const r = await fetch("https://api.vapi.ai/chat", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ assistant, input: msgs.length === 1 ? input : msgs }) });
  const j: any = await r.json();
  if (!r.ok) return `ERR ${r.status} ${JSON.stringify(j).slice(0, 200)}`;
  return (j.output ?? []).filter((m: any) => m.role === "assistant").map((m: any) => m.content ?? JSON.stringify(m.toolCalls ?? "")).join(" ‖ ");
}
const norm = (t: string) => t.toLowerCase().replace(/%/g, " percent").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
async function main() {
  const N = Number(process.env.N || 12);
  const cases: [string, { role: string; content: string }[], string, (o: string) => boolean][] = [
    ["real person: Hello?", [], "Hello?", (o) => norm(o).includes(norm(OPENER))],
    ["real person: Hello? x4", [], "Hello? Hello? Hello? Hello?", (o) => norm(o).includes(norm(OPENER))],
    ["screener asks name", [], "If you record your name and reason for calling, I'll see if this person is available.", (o) => /^\s*iris[.,!]?\s*$/i.test(o)],
    ["hold message after Iris.", [{ role: "user", content: "If you record your name and reason for calling, I'll see if this person is available." }, { role: "assistant", content: "Iris." }], "Thanks. Please stay on the line.", (o) => /\[silent\]|^\s*$/.test(o)],
    ["voicemail greeting", [], "Call has been forwarded to voice mail. The person you're trying to reach is not available.", (o) => !/goodbye|bye|thanks/i.test(o)],
    ["AI question after opener", [{ role: "user", content: "Hello?" }, { role: "assistant", content: OPENER }], "Is this an AI?", (o) => /\bAI\b/.test(o)],
  ];
  cases.push(["screener: who is calling", [], "Please say your name after the tone.", (o) => /^\s*iris[.,!]?\s*$/i.test(o)]);
  cases.push(["screener: Google", [], "The person you're calling is using a Google screening service. Please tell me your name and why you're calling.", (o) => /^\s*iris[.,!]?\s*$/i.test(o)]);
  cases.push(["voicemail: leave a message", [], "Hi, you've reached Angela. Please leave a message after the tone.", (o) => !/this is iris/i.test(o) && o.split(" ‖ ").every((p) => /^\s*(\[silent\]|""|good ?bye[.!]?)?\s*$/i.test(p))]);
  cases.push(["hold music msg", [], "Your call is important to us. Please hold while we connect your call.", (o) => /\[silent\]|^\s*$/.test(o)]);
  cases.push(["person joins after Iris.", [{ role: "user", content: "If you record your name and reason for calling, I'll see if this person is available." }, { role: "assistant", content: "Iris." }, { role: "user", content: "Thanks. Please stay on the line." }, { role: "assistant", content: "[silent]" }], "Hello?", (o) => norm(o).includes(norm(OPENER))]);
  // The lead's stored budget is "$299K-$600K": when Iris verifies it she must say it in words (Noeleen Gray, 2026-10-18: "2 9 9 2 5 euro dollars").
  cases.push([
    "verifying a known budget is said in words",
    [{ role: "user", content: "Hello?" }, { role: "assistant", content: OPENER }, { role: "user", content: "Yes." }, { role: "assistant", content: "How are you doing today?" }, { role: "user", content: "Good." },
     { role: "assistant", content: "You said you're looking to move ASAP. Is that still the plan?" }],
    "Yeah, still the plan.",
    (o) => /budget/i.test(o) ? /thousand|hundred|million/i.test(o) : true,
  ]);
  const starters = ["Hello", "Hi", "Yeah?", "Hello, this is Amanda", "Hello? Who's this?", "Hello? Hello?", "Hello? Can you hear me?", "Hello? Hello? Hello? Hello? Hello?", "Hello?? Anybody there?"];
  for (const st of starters) cases.push(["real person: " + st, [], st, (o) => norm(o).includes(norm(OPENER))]);
  const only = process.env.ONLY === "opener";
  for (const [name, hist, input, ok] of cases.filter((c) => !only || c[0].startsWith("real person"))) {
    let pass = 0; const samples: string[] = [];
    for (let i = 0; i < N; i++) { const o = await turn(hist, input); if (ok(o) && !SPOKEN_FIGURE_PROBLEM.test(o)) pass++; if (samples.length < 2) samples.push(o.slice(0, 130)); }
    console.log(`${pass}/${N}  ${name}   e.g. ${JSON.stringify(samples)}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
