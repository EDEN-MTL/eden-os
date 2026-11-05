/**
 * Direct links to a campaign, ad set or ad in Meta Ads Manager, for Forge's Slack posts and chat answers.
 * Mark, 2026-11-05: "so me and Jacob can go directly to it, not just read a report".
 *
 * The address is the one Ads Manager itself shows after you tick a row: the tab for that level (campaigns,
 * adsets, ads) with the row selected, in the client's own ad account. Where the parents are known they are
 * included too, so the ad set and ad tabs open already filtered the way a person would have clicked in.
 * Needs a Meta login that can see the account, like Ads Manager itself.
 */

export type LinkScope = "campaign" | "adset" | "ad";

export interface LinkParents {
  campaignId?: string | null;
  adsetId?: string | null;
}

const TAB: Record<LinkScope, string> = { campaign: "campaigns", adset: "adsets", ad: "ads" };

/** "act_10150181877529722" or "10150181877529722" -> "10150181877529722". Null when there is no usable id. */
export function accountNumber(adAccountId: string | null | undefined): string | null {
  const digits = String(adAccountId ?? "").replace(/^act_/, "").trim();
  return /^\d+$/.test(digits) ? digits : null;
}

export function adsManagerUrl(adAccountId: string | null | undefined, scope: LinkScope, id: string, parents: LinkParents = {}): string | null {
  const act = accountNumber(adAccountId);
  if (!act || !/^\d+$/.test(id)) return null;
  const params = [`act=${act}`];
  if (scope === "campaign") {
    params.push(`selected_campaign_ids=${id}`);
  } else {
    const campaignId = parents.campaignId && /^\d+$/.test(parents.campaignId) ? parents.campaignId : null;
    if (campaignId) params.push(`selected_campaign_ids=${campaignId}`);
    if (scope === "adset") {
      params.push(`selected_adset_ids=${id}`);
    } else {
      const adsetId = parents.adsetId && /^\d+$/.test(parents.adsetId) ? parents.adsetId : null;
      if (adsetId) params.push(`selected_adset_ids=${adsetId}`);
      params.push(`selected_ad_ids=${id}`);
    }
  }
  return `https://adsmanager.facebook.com/adsmanager/manage/${TAB[scope]}?${params.join("&")}`;
}

/** A Slack mrkdwn link. Slack only needs & < > escaped in the label; a pipe inside the label is fine. */
export function slackLink(url: string | null, label: string): string {
  if (!url) return label;
  const safe = label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<${url}|${safe}>`;
}
