# Forge (ads health) and Lens (reports) working notes

## Forge campaign health

`agents/forge/ads/health.ts` + Forge tool `get_campaign_health` give each campaign /
ad set a verdict: kill, refresh_creative, scale, watch, healthy, too_early.

- Targets per funnel (buyer/seller) live in `forge.health` in client config. Without a
  hand-set `targetCpl`, the target auto-calibrates to the account's own 60-day blended
  CPL — that's the current average, not a goal. Set `targetCpl` for a real goal.
- Kill = 2.5× target spent with 0 leads, or CPL ≥1.75× target. Scale = 3+ leads at
  ≤0.8× target, in +20% steps. CBO-aware; learning phase from `learning_stage_info`.
- `cplThreshold` drives the `auto-cpl-high` Slack alert.
- Daily health digest: `runDailyForgeHealthReport`, 08:15 America/Toronto, forge bot →
  `LENS_OPS_CHANNEL` (internal), opt-in per client via `forge.health`.

## Lead attribution

GHL's Facebook Lead Ads sync stores `attributionSource.campaignId/adSetId/adId` on each
contact — but only the single-contact GET returns it (the LIST endpoint omits it, like
custom fields). `runLeadSync` runs hourly at :50 and re-uses a full record when
`dateUpdated` hasn't changed (`raw.fullRecord`).

- GHL merges repeat submitters, so it counts fewer leads than Meta.
  Forge uses `lead_count = max(GHL, Meta)`.
- Metrics must use the same window for leads and spend (an earlier bug counted all-time
  leads against windowed spend).
- CPL is not daily spend — easy to confuse when explaining numbers.

## Lens reports

Posted to `LENS_OPS_CHANNEL` (#eden-ads). Weekly on Mondays; monthly on the 1st,
08:00 Toronto, covering the previous month.

Funnel (`agents/lens/funnel.ts`, config `lens.funnel`): one line per stage — live
transferred, appointment booked, showed up, signed/closed — split buyer/seller by the
`buyer lead` / `seller lead` tags. A step matches on a tag **or** a pipeline column, and
a step's columns include every later column, because cards move on while tags stay.
Lens's lead count is GHL-attributed only, so it reads lower than Forge's.
