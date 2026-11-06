import { Language } from "./config";

/**
 * Fixed lead-facing texts: the first touch, the follow-up cadence and the opt-out confirmation.
 * These are templates, not model output, on purpose — they go out unattended with no lead
 * message to react to, so every word is reviewed here once (no prices, no promised dates, no
 * claims about what the visit costs) instead of being improvised per lead.
 */

const OWNER = "Pedro";

const greet = (language: Language, name?: string) =>
  language === "fr" ? (name ? `Bonjour ${name}!` : "Bonjour!") : name ? `Hi ${name}!` : "Hi!";

export function firstNameOf(fullName?: string | null): string | undefined {
  const first = (fullName ?? "").trim().split(/\s+/)[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : undefined;
}

export function firstTouchText(language: Language, name?: string): string {
  return language === "fr"
    ? `${greet(language, name)} Ici Iris, l'assistante virtuelle de ${OWNER} chez Planchers Matama. Merci pour votre demande pour le sablage de vos planchers. C'est pour environ combien de pièces ou de pieds carrés?`
    : `${greet(language, name)} This is Iris, ${OWNER}'s virtual assistant at Matama Floors. Thanks for reaching out about your floors. Roughly how many rooms or square feet are we talking about?`;
}

/**
 * Cadence from the brief (section 8): step 1 = +3 hours, step 2 = next morning (both Day 1),
 * step 3 = Day 2 with a different angle (photos), step 4 = Day 3, a short low-pressure check-in.
 */
export const FOLLOWUP_STEPS = 4;

export function followupText(step: number, language: Language, name?: string): string | null {
  const fr: Record<number, string> = {
    1: `${greet("fr", name)} C'est Iris de Planchers Matama. Je voulais m'assurer que vous aviez bien reçu mon message. C'est pour environ combien de pièces ou de pieds carrés?`,
    2: `${greet("fr", name)} Iris de Planchers Matama de nouveau. Dites-moi en quelques mots ce que vous aimeriez faire avec vos planchers et je m'occupe de planifier la visite de ${OWNER}.`,
    3: `${greet("fr", name)} Si vous m'envoyez 2-3 photos de vos planchers, ${OWNER} pourra vous donner une idée de ce que ça implique. Vous n'avez qu'à répondre à ce message.`,
    4: `${greet("fr", name)} Petit mot en passant: si vos planchers sont toujours dans vos plans, je suis là pour planifier la visite de ${OWNER}. Sinon, aucun souci!`,
  };
  const en: Record<number, string> = {
    1: `${greet("en", name)} It's Iris from Matama Floors. Just making sure you got my message. Roughly how many rooms or square feet are we talking about?`,
    2: `${greet("en", name)} Iris from Matama Floors again. Tell me a bit about what you'd like done with your floors and I'll set up a visit with ${OWNER}.`,
    3: `${greet("en", name)} If you send me 2-3 photos of your floors, ${OWNER} can give you an idea of what the job involves. Just reply to this message.`,
    4: `${greet("en", name)} Quick check-in: if your floors are still on your list, I'm here to set up a visit with ${OWNER}. If not, no worries at all!`,
  };
  return (language === "fr" ? fr : en)[step] ?? null;
}

export function optOutConfirmationText(language: Language): string {
  return language === "fr"
    ? "C'est noté, nous ne vous contacterons plus. Bonne continuation!"
    : "Understood, we won't contact you again. Take care!";
}

/**
 * A hard backstop for opt-outs that must never depend on a model: STOP, ARRÊT, "unsubscribe"
 * and the common plain-language ways of asking to stop. Anything subtler is caught by the
 * record_opt_out tool the model has; this only needs to be sure, not clever.
 */
const OPT_OUT_WORD = /^[\s"'.!¡]*(stop|stopp|arr[eê]t|arr[eê]te|arr[eê]tez|unsubscribe|d[eé]sabonner|d[eé]sabonnez|d[eé]sinscrire)[\s"'.!]*$/i;
const OPT_OUT_PHRASE = [
  /\bne\s+(me\s+)?contact(ez|er)\s+plus\b/i,
  /\bne\s+plus\s+me\s+(contacter|texter|[eé]crire|envoyer)\b/i,
  /\bretir(ez|er)[\s-]+moi\b/i,
  /\bsupprim(ez|er)\s+mon\s+num[eé]ro\b/i,
  /\b(stop|arr[eê]t(ez|er)?)\s+(texting|messaging|contacting|de\s+(me\s+)?(texter|contacter|[eé]crire|m['’]envoyer))\b/i,
  /\b(don['’]?t|do\s+not)\s+(text|message|contact)\s+me\b/i,
  /\bremove\s+(me|my\s+number)\b/i,
  /\bunsubscribe\b/i,
  /\bstop\s+(it|this|please|svp)\b/i,
];

export function isOptOut(text: string): boolean {
  const t = text.trim();
  return OPT_OUT_WORD.test(t) || OPT_OUT_PHRASE.some((re) => re.test(t));
}
