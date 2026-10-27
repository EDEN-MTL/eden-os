import { formatValue, NA } from "./format";
import { rankRevenue } from "./revenue-rank";
import type { CampaignsResponse } from "./types";

/**
 * Which campaign brought in the revenue: one bar per campaign, biggest first, sized against the largest. The
 * headline names the top campaign and how many deals stand behind it, since a few deals is a small sample.
 */
export default function RevenueByCampaign({ data }: { data: CampaignsResponse }) {
  const { bars, top, total, idle } = rankRevenue(data);
  const max = Math.max(1, ...bars.map((b) => b.revenue));
  const untied = bars.find((b) => !b.tied);

  return (
    <figure className="lens-chart lens-chart-wide">
      <figcaption>
        <span className="lens-chart-title">Revenue by campaign</span>
        <span className="lens-chart-sub">Value of the deals that closed in this period, by the campaign that brought the lead in</span>
      </figcaption>
      {bars.length === 0 ? (
        <div className="lens-chart-empty">No closed-deal revenue in this period. Try a longer period: deals close weeks or months after the ad ran.</div>
      ) : (
        <>
          <p className="lens-revenue-lead">
            {top ? (
              <>
                <strong>{top.name}</strong> brought in the most revenue: <strong>{formatValue(top.revenue, "currency")}</strong>
                {top.deals !== null && <> from {top.deals} closed deal{top.deals === 1 ? "" : "s"}</>}
                {top.share !== null && <>, {top.share.toFixed(0)}% of the {formatValue(total, "currency")} recorded</>}.
              </>
            ) : (
              <>None of the {formatValue(total, "currency")} recorded this period can be traced to a campaign.</>
            )}
            {top && untied && <> A further {formatValue(untied.revenue, "currency")} closed from leads with no campaign recorded.</>}
          </p>
          <ul className="lens-revenue-bars" aria-label="Revenue by campaign, biggest first">
            {bars.map((b) => (
              <li key={b.key}>
                <span className={`lens-revenue-name${b.tied ? "" : " is-untied"}`} title={b.name}>{b.name}</span>
                <span className="lens-revenue-track">
                  <span className={`lens-revenue-fill${b.tied ? "" : " is-untied"}`} style={{ width: `${(b.revenue / max) * 100}%` }} />
                </span>
                <span className="lens-revenue-val">
                  <strong>{formatValue(b.revenue, "currency")}</strong>
                  {b.share !== null && <span> · {b.share.toFixed(0)}%</span>}
                </span>
                <span className="lens-revenue-meta">
                  {b.deals !== null ? `${b.deals} deal${b.deals === 1 ? "" : "s"}` : NA}
                  {b.tied ? ` · spend ${formatValue(b.spend, "currency")} · ROAS ${formatValue(b.roas, "ratio")}` : " · cannot be traced to an ad"}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {idle.count > 0 && (
        <p className="lens-footnote">
          {idle.count} other campaign{idle.count === 1 ? "" : "s"} spent {formatValue(idle.spend, "currency")} with no closed deal in this period. That is not proof they do not work: leads from recent campaigns may still close.
        </p>
      )}
    </figure>
  );
}
