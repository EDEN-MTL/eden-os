// Placeholder content ported from the design brief — no real per-agent
// activity data exists yet. Swap for real feeds once agents log activity
// somewhere queryable.
import { glow } from "./agents";

export interface DossierEntry {
  task: string;
  m1l: string;
  m1v: string;
  m2l: string;
  m2v: string;
}

export const DOSSIER: Record<string, DossierEntry> = {
  SCT: { task: "Ingesting Coral Springs Meta form fills — enriching with property history and equity estimate.", m1l: "CAPTURED TODAY", m1v: "47", m2l: "ENRICH RATE", m2v: "96%" },
  IRS: { task: "Live voice call — Whitfield, T. Qualifying budget and timeline before warm transfer.", m1l: "ACTIVE THREADS", m1v: "3", m2l: "AVG RESPONSE", m2v: "4s" },
  ATL: { task: "Matching Iris handoff to a buyer specialist on shift. Martinez paused at capacity.", m1l: "BOOKED TODAY", m1v: "11", m2l: "ROUTE TIME", m2v: "9s" },
  EMB: { task: "Holding 340 long-cycle leads. Reactivated a 4-month dormant record 18m ago.", m1l: "IN NURTURE", m1v: "340", m2l: "REACTIVATED", m2v: "7" },
  MUS: { task: "Drafted 4 listing captions for the Weston property — awaiting human approval.", m1l: "AWAITING APPR.", m1v: "7", m2l: "PUBLISHED WK", m2v: "18" },
  FRG: { task: "Paused Parkland Buyers 03 at $36.20 CPL. Six replacement creatives compliance-cleared.", m1l: "CAMPAIGNS", m1v: "14", m2l: "ROAS", m2v: "4.2x" },
  LNS: { task: "Bottleneck flagged: Martinez follow-up 3x team average. Routing weight reduced.", m1l: "PIPELINE", m1v: "$2.1M", m2l: "LEAD → APPT", m2v: "23%" },
  NVA: { task: "Palm Beach brokerage at step 4 of 7 — ad account linked, creative assets pending.", m1l: "ONBOARDING", m1v: "2", m2l: "TIME TO LIVE", m2v: "9d" },
};

function feedItem(agent: string, time: string, text: string, color: string) {
  return { agent, time, text, color, glow: glow(color, 0.7) };
}
function metric(label: string, value: string, delta: string, color: string) {
  return { label, value, delta, color, glow: glow(color, 0.5) };
}
function sideItem(head: string, text: string, color: string) {
  return { head, text, color, glow: glow(color, 0.6) };
}

export const TABS = ["COMMAND", "LEADS", "ISA", "ADS", "CONTENT", "INTEL", "CLIENTS", "SETTINGS"];

export const MODULES: Record<string, any> = {
  LEADS: {
    eyebrow: "SCOUT · IRIS · ATLAS",
    title: "LEAD PIPELINE",
    metrics: [metric("CAPTURED TODAY", "47", "↑ 12%", "#00b8ff"), metric("QUALIFIED", "19", "↑ 8%", "#a78bfa"), metric("BOOKED", "11", "", "#00e5ff"), metric("IN NURTURE", "340", "", "#ffa800")],
    feedLabel: "PIPELINE ACTIVITY",
    feed: [
      feedItem("SCOUT", "2m ago", "3 leads captured — Coral Springs Meta campaign. Enriched with property history + equity estimate.", "#00b8ff"),
      feedItem("IRIS", "4m ago", "Warm transfer → Diaz. Brief: buyer $450k, pool home, 60 days.", "#a78bfa"),
      feedItem("ATLAS", "5m ago", "Showing booked tomorrow 2pm — agent brief sent to mobile.", "#00e5ff"),
      feedItem("IRIS", "11m ago", "Qualified 4 of 6 inbound texts. 2 flagged as unresponsive after 3 attempts.", "#a78bfa"),
      feedItem("EMBER", "18m ago", "Reactivated cold lead — dormant 4 months, re-entered qualification.", "#ffa800"),
      feedItem("ATLAS", "26m ago", "Round-robin rebalanced — Martinez at capacity, routing paused.", "#00e5ff"),
    ],
    sideLabel: "STAGE DISTRIBUTION",
    side: [
      sideItem("NEW · 47", "Captured today, awaiting Iris first-touch. Median time to contact: 38 seconds.", "#00b8ff"),
      sideItem("QUALIFYING · 19", "Active voice or text qualification in progress with Iris.", "#a78bfa"),
      sideItem("BOOKED · 11", "Appointments confirmed by Atlas with agent briefs delivered.", "#00e5ff"),
      sideItem("NURTURE · 340", "Long-cycle sequences held by Ember until intent signals fire.", "#ffa800"),
    ],
  },
  ISA: {
    eyebrow: "IRIS · AI INSIDE SALES AGENT",
    title: "AI ISA",
    metrics: [metric("ACTIVE CALLS", "1", "", "#a78bfa"), metric("ACTIVE TEXTS", "2", "", "#00b8ff"), metric("AVG RESPONSE", "4s", "", "#00fff2"), metric("WARM TRANSFERS", "6", "↑ 3 today", "#00ff88")],
    feedLabel: "LIVE CONVERSATION · VOICE",
    feed: [
      feedItem("IRIS", "live · 02:41", "Call in progress — Whitfield, T. Inbound from Weston listing ad.", "#a78bfa"),
      feedItem("IRIS", "02:20", "“Are you looking to buy, sell, or both this year?” → Buying, first home.", "#a78bfa"),
      feedItem("IRIS", "01:52", "Budget confirmed: $380k–$450k. Pre-approval in hand.", "#a78bfa"),
      feedItem("IRIS", "01:14", "Timeline: 45–60 days. Areas: Weston, Davie. Must-have: fenced yard.", "#a78bfa"),
      feedItem("IRIS", "00:36", "Intent score 87. Preparing warm transfer + agent brief.", "#a78bfa"),
      feedItem("ATLAS", "00:04", "Receiving handoff — matching to buyer specialist on shift.", "#00e5ff"),
    ],
    sideLabel: "RECENT WARM TRANSFERS",
    side: [
      sideItem("→ DIAZ, M.", "Buyer $450k, pool home, 60 days. Pre-approved. Brief delivered 4m ago.", "#a78bfa"),
      sideItem("→ MARTINEZ, R.", "Seller, Coral Springs, wants valuation + net sheet. Delivered 22m ago.", "#00e5ff"),
      sideItem("→ OKAFOR, J.", "Relocation buyer, cash, 30 days. Escalated as priority. 1h ago.", "#00ff88"),
      sideItem("→ HOLD QUEUE", "2 leads awaiting agent availability — Ember holding with nurture touch.", "#ffa800"),
    ],
  },
  ADS: {
    eyebrow: "FORGE · AD ENGINE",
    title: "AD ENGINE",
    metrics: [metric("ACTIVE CAMPAIGNS", "14", "", "#ff2255"), metric("ROAS", "4.2x", "↑ 0.4", "#00ff88"), metric("CPL", "$18.40", "↓ $2.10", "#00fff2"), metric("DAILY SPEND", "$340", "", "#ffa800")],
    feedLabel: "ENGINE ACTIVITY",
    feed: [
      feedItem("FORGE", "1h ago", "Paused underperformer — CPL exceeded $35 threshold on Parkland Buyers 03.", "#ff2255"),
      feedItem("FORGE", "1h ago", "Scaled Coral Springs Sellers +25% budget — CPL $12.80, 3-day trend stable.", "#ff2255"),
      feedItem("FORGE", "2h ago", "6 new creatives generated for Weston listing — 3 static, 3 video hooks.", "#ff2255"),
      feedItem("FORGE", "3h ago", "Compliance check passed: housing policy review on 6 new assets.", "#ff2255"),
      feedItem("MUSE", "4h ago", "Copy variants drafted for Davie campaign — awaiting approval.", "#ec4899"),
      feedItem("LENS", "5h ago", "Attribution reconciled: 11 booked appointments traced to Meta spend.", "#00ff88"),
    ],
    sideLabel: "TOP CAMPAIGNS",
    side: [
      sideItem("CORAL SPRINGS SELLERS", "CPL $12.80 · 6.1x ROAS · scaling. Best performer this week.", "#00ff88"),
      sideItem("WESTON BUYERS", "CPL $17.40 · 4.4x ROAS · holding. New creative set entering test.", "#00b8ff"),
      sideItem("PARKLAND BUYERS 03", "CPL $36.20 · paused by Forge. Creative fatigue after 9 days.", "#ff2255"),
      sideItem("DAVIE FIRST-TIME", "CPL $21.10 · 3.2x ROAS · learning phase, 2 days remaining.", "#ffa800"),
    ],
  },
  INTEL: {
    eyebrow: "LENS · ANALYTICS & INTELLIGENCE",
    title: "INTEL",
    metrics: [metric("PIPELINE VALUE", "$2.1M", "↑ 9%", "#00ff88"), metric("LEAD → APPT", "23%", "↑ 2pt", "#00b8ff"), metric("APPT → CLOSE", "31%", "", "#00fff2"), metric("AD SPEND MTD", "$8.4k", "", "#ffa800")],
    feedLabel: "BOTTLENECK ALERTS",
    feed: [
      feedItem("LENS", "30m ago", "Bottleneck flagged: Martinez follow-up 3x above team average. Routing weight reduced.", "#00ff88"),
      feedItem("LENS", "2h ago", "Speed-to-lead degraded 11% on weekend inbound — Iris coverage window extended.", "#00ff88"),
      feedItem("LENS", "6h ago", "Nurture cohort from March showing 4% reactivation lift after Ember rewrite.", "#00ff88"),
      feedItem("LENS", "1d ago", "Weekly report delivered to #eden-command — 14 campaigns, 312 leads, 67 appts.", "#00ff88"),
      feedItem("LENS", "1d ago", "Forecast updated: 21 closings projected this quarter at current conversion.", "#00ff88"),
    ],
    sideLabel: "WEEKLY REPORT",
    side: [
      sideItem("LEADS · 312 MTD", "Up 14% over prior month. Meta is 78% of source volume.", "#00b8ff"),
      sideItem("APPOINTMENTS · 67", "23% of leads booked. Iris qualification is the largest lift driver.", "#00e5ff"),
      sideItem("CLOSINGS · 21 PROJ.", "31% appointment-to-close held flat for three consecutive weeks.", "#00ff88"),
      sideItem("EFFICIENCY", "Blended CPL $18. Cost per appointment $126, down from $158.", "#ffa800"),
    ],
  },
  CONTENT: {
    eyebrow: "MUSE · CONTENT & MARKETING",
    title: "CONTENT",
    metrics: [metric("AWAITING APPROVAL", "7", "", "#ec4899"), metric("PUBLISHED THIS WEEK", "18", "↑ 5", "#00b8ff"), metric("ENGAGEMENT", "3.8%", "↑ 0.6pt", "#00fff2"), metric("ASSETS IN QUEUE", "24", "", "#ffa800")],
    feedLabel: "PRODUCTION FEED",
    feed: [
      feedItem("MUSE", "12m ago", "Drafted 4 listing captions for Weston property — awaiting approval.", "#ec4899"),
      feedItem("MUSE", "48m ago", "Market update reel scripted — South Florida inventory shift, 45s cut.", "#ec4899"),
      feedItem("MUSE", "2h ago", "Neighborhood guide drafted: Coral Springs schools + commute data.", "#ec4899"),
      feedItem("FORGE", "3h ago", "3 approved creatives pushed live into Weston Buyers ad set.", "#ff2255"),
      feedItem("MUSE", "5h ago", "Email sequence rewritten for Ember 90-day dormant cohort.", "#ec4899"),
    ],
    sideLabel: "APPROVAL QUEUE",
    side: [
      sideItem("LISTING CAPTIONS · 4", "Weston 4/3 pool home. Muse holds until human approval.", "#ec4899"),
      sideItem("MARKET REEL · 1", "45-second inventory update. Voiceover script attached.", "#00b8ff"),
      sideItem("EMAIL SEQUENCE · 2", "Reactivation rewrite for Ember. A/B variants prepared.", "#ffa800"),
    ],
  },
  CLIENTS: {
    eyebrow: "NOVA · CLIENT ONBOARDING",
    title: "CLIENTS",
    metrics: [metric("ACTIVE CLIENTS", "1", "", "#f97316"), metric("IN ONBOARDING", "2", "", "#00b8ff"), metric("AVG TIME TO LIVE", "9d", "↓ 3d", "#00fff2"), metric("SEATS DEPLOYED", "14", "", "#00ff88")],
    feedLabel: "ONBOARDING ACTIVITY",
    feed: [
      feedItem("NOVA", "20m ago", "Meta ad account access confirmed — Palm Beach brokerage, step 4 of 7.", "#f97316"),
      feedItem("NOVA", "1h ago", "CRM field mapping complete. 1,240 historical leads imported for Ember.", "#f97316"),
      feedItem("NOVA", "3h ago", "Agent roster ingested: 9 agents, routing rules drafted for Atlas.", "#f97316"),
      feedItem("NOVA", "1d ago", "Kickoff call recorded and summarized to #eden-command.", "#f97316"),
      feedItem("LENS", "1d ago", "Baseline benchmarks captured for pre-launch comparison.", "#00ff88"),
    ],
    sideLabel: "ACCOUNTS",
    side: [
      sideItem("3 PERCENT EAST COAST", "Live · South Florida. 312 leads MTD, 67 appointments, $18 CPL.", "#00ff88"),
      sideItem("PALM BEACH BROKERAGE", "Onboarding · step 4 of 7. Ad account linked, creative pending.", "#00b8ff"),
      sideItem("TREASURE COAST GROUP", "Onboarding · step 2 of 7. Contract signed, CRM audit scheduled.", "#f97316"),
    ],
  },
};
