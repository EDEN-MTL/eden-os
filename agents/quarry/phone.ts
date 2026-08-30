/**
 * Module 2b — phone line-type verification.
 *
 * Runs before site generation so credits are never spent on a business that
 * cannot receive a text. Twilio Lookup v2 is the default provider; the
 * interface exists so another can replace it without touching the pipeline.
 *
 * No carrier lookup is exact. Ported numbers, resold lines and small Canadian
 * carriers are all occasionally misclassified, so this is a strong filter that
 * avoids obviously wasted effort — not a guarantee about any single number.
 */
import { PhoneLookup, PhoneLookupProvider } from "./types";
import { cacheLookup, getCachedLookup } from "./store";

/**
 * Normalises a Canadian number to E.164, which Twilio requires.
 *
 * Google returns nationally formatted numbers like "(514) 555-0123". Sending
 * that to Lookup fails outright, which is the good case; the bad case is a
 * 10-digit string being accepted against the wrong region. Explicit +1 for
 * 10-digit input, since every lead in this pipeline is Canadian.
 */
export function toE164(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits.length >= 11 ? digits : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Twilio's line types, mapped to a send/hold decision.
 *
 * "personal" and "mobile" can receive SMS. "landline" cannot. VOIP is the
 * genuinely ambiguous case — plenty of small businesses run a fixed-VOIP line
 * that does receive texts, and plenty do not — so it is neither sent nor
 * discarded, it is held for a human. Collapsing VOIP into false would quietly
 * throw away a real slice of the market.
 */
export type SendDecision = "send" | "holdout" | "reject";

export function decideFromLineType(
  lineType: string,
  voipPolicy: "holdout" | "reject" | "allow"
): SendDecision {
  switch (lineType) {
    case "mobile":
    case "personal":
      return "send";
    case "landline":
      return "reject";
    case "fixedVoip":
    case "nonFixedVoip":
    case "voip":
      return voipPolicy === "allow" ? "send" : voipPolicy === "reject" ? "reject" : "holdout";
    default:
      // Unknown/absent classification is held, never sent. Twilio returns null
      // line_type for numbers it cannot classify, and guessing "mobile" there
      // means texting landlines.
      return "holdout";
  }
}

export class TwilioLookupProvider implements PhoneLookupProvider {
  readonly name = "twilio";

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string
  ) {}

  async lookup(phone: string): Promise<PhoneLookup> {
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    const res = await fetch(
      `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (!res.ok) {
      throw new Error(`Twilio Lookup ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body: any = await res.json();
    const intel = body.line_type_intelligence ?? {};
    const lineType = intel.type ?? "unknown";
    return {
      phone,
      lineType,
      isMobile: lineType === "mobile" || lineType === "personal",
      carrier: intel.carrier_name ?? null,
      provider: this.name,
      checkedAt: new Date().toISOString(),
      raw: body,
    };
  }
}

export interface VerifyResult {
  lookup: PhoneLookup | null;
  decision: SendDecision;
  /** Populated when the number never reached the provider at all. */
  problem?: string;
  fromCache: boolean;
}

/**
 * Cache-first verification. The cache is keyed by number rather than by lead,
 * because the same business surfacing under a second search query must not
 * cost a second billable lookup.
 */
export async function verifyPhone(
  rawPhone: string | null,
  provider: PhoneLookupProvider,
  opts: { cacheDays: number; voipPolicy: "holdout" | "reject" | "allow" }
): Promise<VerifyResult> {
  const phone = toE164(rawPhone);
  if (!phone) {
    return { lookup: null, decision: "holdout", problem: "No usable phone number", fromCache: false };
  }

  const cached = await getCachedLookup(phone, opts.cacheDays);
  if (cached) {
    return { lookup: cached, decision: decideFromLineType(cached.lineType, opts.voipPolicy), fromCache: true };
  }

  const lookup = await provider.lookup(phone);
  await cacheLookup(lookup);
  return { lookup, decision: decideFromLineType(lookup.lineType, opts.voipPolicy), fromCache: false };
}
