import { formatValue, NA } from "./format";
import type { AttributionResponse, AttributionStatus, ChainStep, DealRow } from "./types";

const LABEL: Record<AttributionStatus, string> = { confirmed: "Confirmed", partial: "Partial", unknown: "Unknown" };

function Pill({ status }: { status: AttributionStatus }) {
  return <span className={`lens-pill is-${status}`}>{LABEL[status]}</span>;
}

/** One step of the chain: the total, and how much of it is confirmed / partial / unknown as a stacked bar. */
function Step({ step }: { step: ChainStep }) {
  const total = step.total ?? 0;
  const part = (n: number | null) => (total > 0 && n ? (n / total) * 100 : 0);
  const fmt = (n: number | null) => formatValue(n, step.unit);
  return (
    <li className="lens-step">
      <div className="lens-step-label">{step.label}</div>
      <div className="lens-step-total">{fmt(step.total)}</div>
      <div className="lens-stack" role="img" aria-label={`${step.label}: ${fmt(step.confirmed)} confirmed, ${fmt(step.partial)} partial, ${fmt(step.unknown)} unknown`}>
        <span className="is-confirmed" style={{ width: `${part(step.confirmed)}%` }} />
        <span className="is-partial" style={{ width: `${part(step.partial)}%` }} />
        <span className="is-unknown" style={{ width: `${part(step.unknown)}%` }} />
      </div>
      <dl className="lens-step-split">
        <div><dt><i className="is-confirmed" />Confirmed</dt><dd>{fmt(step.confirmed)}</dd></div>
        <div><dt><i className="is-partial" />Partial</dt><dd>{fmt(step.partial)}</dd></div>
        <div><dt><i className="is-unknown" />Unknown</dt><dd>{fmt(step.unknown)}</dd></div>
      </dl>
    </li>
  );
}

function appointmentCell(d: DealRow, basis: "calendar" | "pipeline"): string {
  if (basis === "calendar") return d.appointments.length ? `${d.appointments.length} (${d.appointments.join(", ")})${d.attended ? ", attended" : ""}` : "none on calendar";
  return d.attended ? "Attended" : d.booked ? "Booked" : "No";
}

/**
 * The closed-deal story, from ad to revenue: the chain with its confirmed / partial / unknown split, every closed
 * deal behind the totals with its evidence, the original lead sources, what is missing, and the rules in words.
 */
export default function Attribution({ data }: { data: AttributionResponse }) {
  const { chain, deals, sources, quality, methodology } = data;
  const closed = chain.find((s) => s.id === "closed");
  const revenue = chain.find((s) => s.id === "revenue");
  return (
    <div className="lens-attr">
      <p className="lens-attr-lead">
        {data.ads.spend !== null ? (
          <>
            <strong>{formatValue(data.ads.spend, "currency")}</strong> was spent on ads and Meta recorded <strong>{formatValue(data.ads.metaLeads, "count")}</strong> leads in this period.{" "}
          </>
        ) : (
          <>No Meta ad spend is available for this client in this period. </>
        )}
        {closed && revenue && (
          <>
            {data.allLeadsFromAds ? (
              <>
                Of the <strong>{formatValue(closed.total, "count")}</strong> deals that closed in it ({formatValue(revenue.total, "currency")}), all count as from ads; <strong>{formatValue(closed.confirmed, "count")}</strong> ({formatValue(revenue.confirmed, "currency")}) can also be tied to an exact campaign.
              </>
            ) : (
              <>
                Of the <strong>{formatValue(closed.total, "count")}</strong> deals that closed in it, <strong>{formatValue(closed.confirmed, "count")}</strong> are confirmed from ads ({formatValue(revenue.confirmed, "currency")} of the {formatValue(revenue.total, "currency")} recorded).
              </>
            )}
          </>
        )}
      </p>

      <ol className="lens-chain" aria-label="Lead to revenue chain">
        {chain.map((s) => (
          <Step key={s.id} step={s} />
        ))}
      </ol>
      <p className="lens-footnote">
        Leads, appointments and deals are people counted once. The three columns always add up to the total. Revenue is only the value recorded in GHL.
      </p>

      {(quality.closedDealsMissingValue.length > 0 || quality.closedDealsNotConfirmed > 0 || !quality.metaHistoryStarts) && (
        <div className="lens-banner is-warn" role="note">
          <strong>What is missing</strong>
          <ul>
            {quality.closedDealsMissingValue.length > 0 && (
              <li>
                {quality.closedDealsMissingValue.length} closed deal{quality.closedDealsMissingValue.length === 1 ? " has" : "s have"} no value recorded in GHL: {quality.closedDealsMissingValue.map((d) => d.name ?? d.contactId).join(", ")}. Revenue is understated by these.
              </li>
            )}
            {quality.closedDealsNotConfirmed > 0 && (
              <li>
                {data.allLeadsFromAds ? (
                  <>
                    {quality.closedDealsNotConfirmed} closed deal{quality.closedDealsNotConfirmed === 1 ? " has" : "s have"} no exact campaign recorded (partial or unknown). {quality.closedDealsNotConfirmed === 1 ? "It still counts" : "They still count"} in ROAS and cost per closed deal, but cannot be placed on a campaign.
                  </>
                ) : (
                  <>
                    {quality.closedDealsNotConfirmed} closed deal{quality.closedDealsNotConfirmed === 1 ? " is" : "s are"} not confirmed from ads (partial or unknown), so {quality.closedDealsNotConfirmed === 1 ? "it is" : "they are"} left out of ROAS and cost per closed deal.
                  </>
                )}
              </li>
            )}
            {!quality.metaHistoryStarts && <li>No Meta spend history is held for this client.</li>}
          </ul>
        </div>
      )}

      <h3 className="lens-h3">Closed deals in this period</h3>
      {deals.length === 0 ? (
        <div className="lens-empty">No deals closed in this period.</div>
      ) : (
        <div className="lens-table-wrap">
          <table className="lens-table lens-ledger">
            <thead>
              <tr>
                <th scope="col" className="is-name">Lead</th>
                <th scope="col">Closed</th>
                <th scope="col">Lead arrived</th>
                <th scope="col">Days to close</th>
                <th scope="col">Appointments</th>
                <th scope="col" className="is-evidence">Attribution evidence</th>
                <th scope="col">Value</th>
                <th scope="col">Attribution</th>
              </tr>
            </thead>
            <tbody>
              {deals.map((d) => (
                <tr key={d.contactId}>
                  <th scope="row" className="is-name">
                    {d.name ?? d.contactId}
                    {d.formName && <div className="lens-sub">{d.formName}</div>}
                  </th>
                  <td>{d.closedDate}</td>
                  <td>{d.leadDate}</td>
                  <td>{d.daysToClose ?? NA}</td>
                  <td className="is-text">{appointmentCell(d, data.basis)}</td>
                  <td className="is-evidence">{d.evidence}</td>
                  <td>{d.value === null ? <span className="lens-missing" title="No value recorded in GHL">missing</span> : formatValue(d.value, "currency")}</td>
                  <td><Pill status={d.attribution} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="lens-h3">By original lead source</h3>
      {sources.length === 0 ? (
        <div className="lens-empty">No leads in this period.</div>
      ) : (
        <div className="lens-table-wrap">
          <table className="lens-table">
            <thead>
              <tr>
                <th scope="col" className="is-name">Source</th>
                <th scope="col">Leads</th>
                <th scope="col">Confirmed</th>
                <th scope="col">Partial</th>
                <th scope="col">Unknown</th>
                <th scope="col">Booked</th>
                <th scope="col">Closed deals</th>
                <th scope="col">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.source}>
                  <th scope="row" className="is-name">{s.source}</th>
                  <td>{s.leads}</td>
                  <td>{s.confirmed}</td>
                  <td>{s.partial}</td>
                  <td>{s.unknown}</td>
                  <td>{formatValue(s.booked, "count")}</td>
                  <td>{formatValue(s.closedDeals, "count")}</td>
                  <td>{formatValue(s.revenue, "currency")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="lens-method-box" open>
        <summary>How attribution is worked out</summary>
        <dl>
          {methodology.map((m) => (
            <div key={m.title}>
              <dt>{m.title}</dt>
              <dd>{m.text}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
