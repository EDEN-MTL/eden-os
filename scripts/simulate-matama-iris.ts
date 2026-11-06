/**
 * Offline simulation of Iris's home-services text flow for Matama: ten scripted lead scenarios, each
 * played by a second model, run against the REAL engine with in-memory fakes. Every conversation
 * starts where production does: after Pedro's GHL automation has texted the lead and asked how big
 * the job is, with the lead's reply. Nothing here touches the database, GHL, Slack or a real lead.
 * It does make real model calls, which cost money.
 *
 *   ANTHROPIC_API_KEY=... npx tsx scripts/simulate-matama-iris.ts [--only=3,5] [--out=report.md] [--max-calls=150]
 */
import Anthropic from "@anthropic-ai/sdk";
import { ask, chatWithTools, ChatMessage, ToolDef } from "../shared/claude";
import { ColumnKey, parseHomeServicesConfig } from "../agents/iris/home-services/config";
import { HsDeps, enrollLead, handleInbound } from "../agents/iris/home-services/engine";
import { LeadInfo } from "../agents/iris/home-services/lead-info";
import { ThreadText } from "../agents/iris/home-services/prompt";
import { HsLead, LeadStatus, createMemoryStore } from "../agents/iris/home-services/store";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const ONLY = arg("only")?.split(",").map(Number);
const OUT = arg("out");
const MAX_CALLS = Number(arg("max-calls") ?? 150);

const COLUMNS = { day1: "S-day1", day2: "S-day2", day3: "S-day3", looseDay: "S-loose-day", looseNight: "S-loose-night" };
const config = parseHomeServicesConfig({
  clientId: "matama-floors",
  ghl: { pipelineId: "P1" },
  slack: { clientChannel: "sim" },
  irisHomeServices: { enabled: true, columns: COLUMNS, intakeStages: ["S-day1"], enrollNotBefore: "2026-11-01T00:00:00Z" },
})!;
const STAGE_NAME = Object.fromEntries(Object.entries(COLUMNS).map(([k, v]) => [v, k]));

/** The English text is what Pedro's automation really sends (seen 2026-11-05); the French is an approximation of it. */
const AUTOMATION: Record<"fr" | "en", (name: string) => string[]> = {
  en: (name) => [
    `Hi ${name}, this is Pedro from Planchers MatAma. I saw your request for floor restoration and the offer for up to $500 off. Reply STOP to unsubscribe. Thanks, Pedro Marques`,
    "My virtual assistant Iris will ask a few quick questions so I can prepare for the estimate. To start: roughly how many square feet or rooms is it?",
  ],
  fr: (name) => [
    `Bonjour ${name}, c'est Pedro de Planchers MatAma. J'ai vu votre demande de restauration de planchers et l'offre jusqu'à 500 $ de rabais. Répondez STOP pour ne plus recevoir de messages. Merci, Pedro Marques`,
    "Mon assistante virtuelle Iris va vous poser quelques questions rapides pour que je prépare l'estimation. Pour commencer: c'est pour environ combien de pieds carrés ou de pièces?",
  ],
};

interface Scenario {
  title: string;
  language: "fr" | "en";
  contact: LeadInfo;
  /** What the lead knows and how they behave; the lead-simulator plays this. */
  persona: string;
  /** The lead's scripted reply to the automation's size question. */
  opening: string;
  maxTurns: number;
  expect: { column?: ColumnKey; status?: LeadStatus; tags?: string[]; noPrice?: boolean; alertHas?: string[] };
}

const SCENARIOS: Scenario[] = [
  {
    title: "French lead, evening (Loose Night)",
    language: "fr",
    contact: { fullName: "Marie Tremblay", phone: "514-555-0142", language: "fr" },
    persona: "Marie Tremblay, 1456 rue Beaubien Est, Rosemont, H2G 1K7. Planchers de chêne à sabler, environ 700 pieds carrés. Libre le soir après 18h en semaine, le samedi ça va aussi. Peut envoyer des photos. Répond brièvement, vouvoie, donne l'information seulement quand on la lui demande.",
    opening: "Environ 700 pieds carrés",
    maxTurns: 8,
    expect: { column: "looseNight", status: "active", alertHas: ["Beaubien", "H2G 1K7", "514-555-0142"] },
  },
  {
    title: "English lead, morning (Loose Day)",
    language: "en",
    contact: { fullName: "Abderr Kahil", phone: "514-555-0177", language: "en" },
    persona: "Abderr Kahil, 4521 Wellington St, Verdun, H4G 1V9. Wants his hardwood sanded, 885 sq ft. Free weekday mornings, not Saturdays. Short, casual texts. Only gives information when asked.",
    opening: "885 ft2",
    maxTurns: 8,
    expect: { column: "looseDay", status: "active", alertHas: ["Wellington", "H4G 1V9"] },
  },
  {
    title: "French lead, afternoon with an exact time (Loose Day, time kept in the notes)",
    language: "fr",
    contact: { fullName: "Luc Gagnon", phone: "450-555-0111", language: "fr" },
    persona: "Luc Gagnon, 88 boulevard des Laurentides, Laval, H7N 2T1. Environ 300 pieds carrés. Il est libre l'après-midi, idéalement mardi le 18 novembre vers 15h. Répond brièvement.",
    opening: "300 pi2 environ",
    maxTurns: 8,
    expect: { column: "looseDay", status: "active", alertHas: ["Laurentides", "H7N 2T1"] },
  },
  {
    title: "Price-only request (no number may be given)",
    language: "fr",
    contact: { fullName: "Karine Poirier", phone: "514-555-0120", language: "fr" },
    persona: "Karine Poirier. Veut juste savoir c'est combien du pied carré, par texto. Insiste pour avoir un prix chiffré et refuse une visite. Si on ne lui donne pas de chiffre après deux relances, elle dit merci et laisse tomber. Messages très courts.",
    opening: "C'est combien du pi² pour sabler?",
    maxTurns: 6,
    expect: { noPrice: true },
  },
  {
    title: "Opt-out (STOP)",
    language: "fr",
    contact: { fullName: "Denis Côté", phone: "514-555-0133", language: "fr" },
    persona: "Denis Côté, ne veut plus être contacté.",
    opening: "ARRÊT",
    maxTurns: 1,
    expect: { status: "opted_out", tags: ["DND"] },
  },
  {
    title: "Water damage (hand off to Pedro)",
    language: "fr",
    contact: { fullName: "Anna Rossi", phone: "514-555-0155", language: "fr" },
    persona: "Anna Rossi, Saint-Léonard. Dégât d'eau dans sa cuisine la semaine dernière, le plancher est mou à certains endroits. Elle veut parler à Pedro aujourd'hui, elle est inquiète.",
    opening: "J'ai eu un dégât d'eau dans ma cuisine et le plancher est mou à certains endroits. Je veux parler à Pedro aujourd'hui.",
    maxTurns: 4,
    expect: { status: "needs_pedro", tags: ["Needs Pedro"] },
  },
  {
    title: "Commercial / very large job (hand off)",
    language: "fr",
    contact: { fullName: "Robert Lavoie", phone: "514-555-0188", language: "fr" },
    persona: "Robert Lavoie, propriétaire d'un immeuble de 12 logements à Montréal-Nord. Veut faire sabler les aires communes et les logements vacants, environ 15 000 pieds carrés au total.",
    opening: "C'est pour un immeuble de 12 logements, environ 15 000 pi² au total.",
    maxTurns: 4,
    expect: { status: "needs_pedro", tags: ["Needs Pedro"] },
  },
  {
    title: "English lead outside the service area",
    language: "en",
    contact: { fullName: "Priya Nair", phone: "416-555-0144", language: "en" },
    persona: "Priya Nair lives in Leslieville, Toronto, with about 900 sq ft of hardwood. She had not realised the company is in Montreal. If told the company can't serve her area she says thanks and goodbye.",
    opening: "900 sq ft. I'm in Leslieville, Toronto, when can someone come?",
    maxTurns: 4,
    expect: { status: "closed", tags: ["Out of Area"] },
  },
  {
    title: "Lead who answers everything in one message",
    language: "fr",
    contact: { fullName: "Julie Roy", phone: "514-555-0199", language: "fr" },
    persona: "Julie Roy a tout donné dans son message. Ensuite elle répond seulement par de brefs remerciements.",
    opening: "600 pi², plutôt le soir. Julie Roy, 2250 rue Ontario Est, Montréal (Hochelaga), H2K 1V7.",
    maxTurns: 3,
    expect: { column: "looseNight", status: "active", alertHas: ["Ontario Est", "H2K 1V7"] },
  },
  {
    title: "Lead asks what the $500 offer covers (Iris must not confirm terms)",
    language: "en",
    contact: { fullName: "Sam Patel", phone: "514-555-0166", language: "en" },
    persona: "Sam Patel, 77 Rue Fleury Ouest, Montreal, H3L 1T2. About 500 sq ft. He is mostly curious about the $500 off: he wants to know if it is guaranteed and what exactly it covers. He is free evenings. If told Pedro will explain at the visit, he is fine with that and gives the information asked.",
    opening: "About 500 sq ft. Is the $500 off guaranteed? What does it cover exactly?",
    maxTurns: 8,
    expect: { status: "active" },
  },
];

let modelCalls = 0;
let inTokens = 0;
let outTokens = 0;
let simChars = 0;

async function countedChat(system: string, messages: ChatMessage[], tools: ToolDef[]): Promise<Anthropic.Message> {
  if (++modelCalls > MAX_CALLS) throw new Error(`Aborting: more than ${MAX_CALLS} model calls (--max-calls).`);
  const response = await chatWithTools(system, messages, tools, { maxTokens: 512, temperature: 0.6 });
  inTokens += response.usage.input_tokens;
  outTokens += response.usage.output_tokens;
  return response;
}

async function leadNext(s: Scenario, transcript: { from: "iris" | "lead"; text: string }[]): Promise<string> {
  const system = `You are role-playing a real person texting a floor sanding company in Montreal, to test their assistant. ${s.persona}
Write ONLY the person's next text message: one or two short sentences, the way people actually text, in ${s.language === "fr" ? "French (Quebec)" : "English"}. Only give information the assistant has asked for or that is natural to say next. Never reveal that this is a test. If the conversation has reached its natural end (the assistant has confirmed next steps and you have nothing left to add or ask), reply with exactly [END].`;
  const convo = transcript.map((t) => `${t.from === "iris" ? "Assistant" : "You"}: ${t.text}`).join("\n");
  const user = `Conversation so far:\n${convo}\n\nWrite your next text.`;
  simChars += system.length + user.length;
  const reply = (await ask(system, user)).trim();
  simChars += reply.length;
  return reply;
}

const PRICE = /(\$|€)\s?\d|\d\s?(\$|€|dollars|\/\s?pi|\/\s?sq|par pied|per sq)/i;
const REINTRO = /(ici iris|c'est iris|je suis iris|this is iris|i'm iris|i am iris)/i;

async function runScenario(index: number, s: Scenario): Promise<string> {
  const store = createMemoryStore();
  const calls = { moves: [] as string[], tags: [] as string[], notes: [] as string[], isaNotes: [] as string[], alerts: [] as string[] };
  const history: ChatMessage[] = [];
  const now = new Date("2026-11-05T15:00:00Z"); // Thursday 10:00, Montreal
  const firstName = s.contact.fullName!.split(" ")[0];

  const transcript: { from: "iris" | "lead"; text: string }[] = AUTOMATION[s.language](firstName).map((text) => ({ from: "iris" as const, text }));
  const deps: HsDeps = {
    config,
    store,
    now: () => now,
    chat: countedChat,
    loadHistory: async () => [...history],
    recentTexts: async () => transcript.map((t): ThreadText => ({ from: t.from === "iris" ? "us" : "lead", text: t.text })),
    appendHistory: async (_l, role, content) => void history.push({ role, content }),
    ghl: {
      moveToColumn: async (_l, stageId) => void calls.moves.push(STAGE_NAME[stageId] ?? stageId),
      addTags: async (_l, tags) => void calls.tags.push(...tags),
      writeNote: async (_l, body) => void calls.notes.push(body),
      writeIsaNotes: async (_l, text) => void calls.isaNotes.push(text),
      currentStageId: async () => null,
    },
    alertOwner: async (text) => void calls.alerts.push(text),
    teammateIsTexting: async () => false,
  };

  const lead = { clientId: "matama-floors", contactId: `sim-${index}`, opportunityId: `opp-${index}`, columnKey: null, info: s.contact, lastInboundSeenAt: now };
  await enrollLead(deps, lead);
  let seen = store.outbox.length;

  for (let turn = 0; turn < s.maxTurns; turn++) {
    const text = turn === 0 ? s.opening : await leadNext(s, transcript);
    if (text === "[END]") break;
    transcript.push({ from: "lead", text });
    const current = (await store.getLead(lead.clientId, lead.contactId)) as HsLead;
    await handleInbound(deps, current, text);
    const fresh = store.outbox.slice(seen).filter((r) => r.kind === "reply" || r.kind === "optout_ack");
    seen = store.outbox.length;
    for (const row of fresh) transcript.push({ from: "iris", text: row.body });
    if (fresh.length === 0) break;
  }

  const final = (await store.getLead(lead.clientId, lead.contactId))!;
  const irisTexts = transcript.slice(2).filter((t) => t.from === "iris").map((t) => t.text);
  const checks: [string, boolean][] = [];
  if (s.expect.column) checks.push([`column is ${s.expect.column}`, final.columnKey === s.expect.column]);
  if (s.expect.status) checks.push([`status is ${s.expect.status}`, final.status === s.expect.status]);
  for (const tag of s.expect.tags ?? []) checks.push([`tagged "${tag}"`, calls.tags.includes(tag)]);
  for (const bit of s.expect.alertHas ?? []) checks.push([`ISA Notes (the text Pedro gets) contain "${bit}"`, calls.isaNotes.some((a) => a.includes(bit))]);
  if (s.expect.noPrice) checks.push(["no price in any Iris text", !irisTexts.some((t) => PRICE.test(t))]);
  checks.push(["Iris never re-introduces herself", !irisTexts.some((t) => REINTRO.test(t))]);
  checks.push(["every Iris text is 3 sentences or fewer", irisTexts.every((t) => (t.match(/[.!?](\s|$)/g) ?? []).length <= 3)]);
  const words = irisTexts.map((t) => t.split(/\s+/).filter(Boolean).length);
  checks.push([`length: avg ${(words.reduce((a, b) => a + b, 0) / Math.max(1, words.length)).toFixed(0)} words, longest ${Math.max(0, ...words)} (limit 45)`, Math.max(0, ...words) <= 45]);
  checks.push(["no em dashes, no paragraph breaks", !irisTexts.some((t) => /[—–]|\n/.test(t))]);
  checks.push(["emoji only if the lead used one", !irisTexts.some((t, i) => /\p{Extended_Pictographic}/u.test(t) && !transcript.slice(0, 2 + i * 2 + 1).some((m) => m.from === "lead" && /\p{Extended_Pictographic}/u.test(m.text)))]);
  checks.push(["no text states the amount or terms of the $500 offer", !irisTexts.some((t) => /500/.test(t))]);

  return [
    `## ${index}. ${s.title}`,
    "",
    "**Transcript** (first two lines are Pedro's automation)",
    ...transcript.map((t, i) => `- **${i < 2 ? "Automation" : t.from === "iris" ? "Iris" : "Lead"}:** ${t.text}`),
    "",
    `**Resulting column:** ${final.columnKey ?? "none"}  |  **Status:** ${final.status}  |  **Moves:** ${calls.moves.join(", ") || "none"}  |  **Tags:** ${calls.tags.join(", ") || "none"}`,
    "",
    "**Contact note**",
    calls.notes.length ? "```\n" + calls.notes.join("\n---\n") + "\n```" : "_none written_",
    "",
    "**ISA Notes field (what the GHL workflow texts to Pedro)**",
    calls.isaNotes.length ? calls.isaNotes.map((a) => "> " + a.replace(/\n/g, "\n> ")).join("\n\n") : "_none written_",
    "",
    "**Checks**",
    ...checks.map(([name, ok]) => `- ${ok ? "PASS" : "FAIL"}: ${name}`),
    "",
  ].join("\n");
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set.");
  const sections: string[] = ["# Iris home-services simulation (Matama)", ""];
  for (const [i, scenario] of SCENARIOS.entries()) {
    if (ONLY && !ONLY.includes(i + 1)) continue;
    console.error(`Running ${i + 1}/${SCENARIOS.length}: ${scenario.title}`);
    sections.push(await runScenario(i + 1, scenario));
  }
  sections.push(`---\nModel calls (Iris): ${modelCalls}. Iris tokens: ${inTokens} in / ${outTokens} out. Lead-simulator tokens (approx): ${Math.round(simChars / 4)} in+out.`);
  const report = sections.join("\n");
  if (OUT) {
    await import("fs").then((fs) => fs.writeFileSync(OUT, report));
    console.error(`Wrote ${OUT}`);
  } else console.log(report);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
