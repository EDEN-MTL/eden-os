import { query } from "../../../shared/db";
import { ColumnKey } from "./config";
import { LeadInfo } from "./lead-info";

export type LeadStatus = "active" | "needs_pedro" | "opted_out" | "closed" | "idle";
export type OutboxKind = "first_touch" | "reply" | "followup" | "optout_ack";
export type OutboxStatus = "pending" | "sent" | "drafted" | "cancelled" | "failed";

export interface HsLead {
  clientId: string;
  contactId: string;
  opportunityId: string | null;
  status: LeadStatus;
  columnKey: ColumnKey | null;
  info: LeadInfo;
  followupStep: number;
  nextFollowupAt: Date | null;
  lastInboundSeenAt: Date | null;
  lastOutboundAt: Date | null;
  resolutionReason: string | null;
  enrolledAt: Date;
}

export type LeadPatch = Partial<Omit<HsLead, "clientId" | "contactId" | "enrolledAt">>;

export interface OutboxRow {
  id: number;
  clientId: string;
  contactId: string;
  body: string;
  kind: OutboxKind;
  sendAfter: Date;
  status: OutboxStatus;
}

export interface HsStore {
  getLead(clientId: string, contactId: string): Promise<HsLead | null>;
  /** False when the lead already exists — enrolment is idempotent. */
  insertLead(lead: Omit<HsLead, "enrolledAt">): Promise<boolean>;
  updateLead(clientId: string, contactId: string, patch: LeadPatch): Promise<void>;
  listByStatus(clientId: string, status: LeadStatus): Promise<HsLead[]>;
  dueFollowups(clientId: string, now: Date): Promise<HsLead[]>;
  enqueue(row: { clientId: string; contactId: string; body: string; kind: OutboxKind; sendAfter: Date }): Promise<number>;
  dueOutbox(clientId: string, now: Date): Promise<OutboxRow[]>;
  markOutbox(id: number, status: OutboxStatus, error?: string): Promise<void>;
  cancelPending(clientId: string, contactId: string, kinds: OutboxKind[]): Promise<void>;
}

interface LeadRow {
  client_id: string;
  contact_id: string;
  opportunity_id: string | null;
  status: LeadStatus;
  column_key: ColumnKey | null;
  info: LeadInfo;
  followup_step: number;
  next_followup_at: Date | null;
  last_inbound_seen_at: Date | null;
  last_outbound_at: Date | null;
  resolution_reason: string | null;
  enrolled_at: Date;
}

const toLead = (r: LeadRow): HsLead => ({
  clientId: r.client_id,
  contactId: r.contact_id,
  opportunityId: r.opportunity_id,
  status: r.status,
  columnKey: r.column_key,
  info: r.info ?? {},
  followupStep: r.followup_step,
  nextFollowupAt: r.next_followup_at,
  lastInboundSeenAt: r.last_inbound_seen_at,
  lastOutboundAt: r.last_outbound_at,
  resolutionReason: r.resolution_reason,
  enrolledAt: r.enrolled_at,
});

const COLUMN_FOR_FIELD: Record<keyof LeadPatch, string> = {
  opportunityId: "opportunity_id",
  status: "status",
  columnKey: "column_key",
  info: "info",
  followupStep: "followup_step",
  nextFollowupAt: "next_followup_at",
  lastInboundSeenAt: "last_inbound_seen_at",
  lastOutboundAt: "last_outbound_at",
  resolutionReason: "resolution_reason",
};

export const pgStore: HsStore = {
  async getLead(clientId, contactId) {
    const rows = await query<LeadRow>(`SELECT * FROM iris_hs_leads WHERE client_id = $1 AND contact_id = $2`, [clientId, contactId]);
    return rows[0] ? toLead(rows[0]) : null;
  },

  async insertLead(l) {
    const rows = await query<{ contact_id: string }>(
      `INSERT INTO iris_hs_leads (client_id, contact_id, opportunity_id, status, column_key, info, followup_step, next_followup_at, last_inbound_seen_at, last_outbound_at, resolution_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (client_id, contact_id) DO NOTHING RETURNING contact_id`,
      [l.clientId, l.contactId, l.opportunityId, l.status, l.columnKey, JSON.stringify(l.info), l.followupStep, l.nextFollowupAt, l.lastInboundSeenAt, l.lastOutboundAt, l.resolutionReason]
    );
    return rows.length > 0;
  },

  async updateLead(clientId, contactId, patch) {
    const sets: string[] = [];
    const values: unknown[] = [clientId, contactId];
    for (const [field, value] of Object.entries(patch) as [keyof LeadPatch, unknown][]) {
      if (value === undefined) continue;
      values.push(field === "info" ? JSON.stringify(value) : value);
      sets.push(`${COLUMN_FOR_FIELD[field]} = $${values.length}`);
    }
    if (sets.length === 0) return;
    await query(`UPDATE iris_hs_leads SET ${sets.join(", ")}, updated_at = now() WHERE client_id = $1 AND contact_id = $2`, values);
  },

  async listByStatus(clientId, status) {
    const rows = await query<LeadRow>(`SELECT * FROM iris_hs_leads WHERE client_id = $1 AND status = $2 ORDER BY enrolled_at`, [clientId, status]);
    return rows.map(toLead);
  },

  async dueFollowups(clientId, now) {
    const rows = await query<LeadRow>(
      `SELECT * FROM iris_hs_leads WHERE client_id = $1 AND status = 'active' AND next_followup_at IS NOT NULL AND next_followup_at <= $2 ORDER BY next_followup_at`,
      [clientId, now]
    );
    return rows.map(toLead);
  },

  async enqueue(row) {
    const rows = await query<{ id: string }>(
      `INSERT INTO iris_hs_outbox (client_id, contact_id, body, kind, send_after) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [row.clientId, row.contactId, row.body, row.kind, row.sendAfter]
    );
    return Number(rows[0].id);
  },

  async dueOutbox(clientId, now) {
    const rows = await query<{ id: string; client_id: string; contact_id: string; body: string; kind: OutboxKind; send_after: Date; status: OutboxStatus }>(
      `SELECT * FROM iris_hs_outbox WHERE client_id = $1 AND status = 'pending' AND send_after <= $2 ORDER BY send_after, id`,
      [clientId, now]
    );
    return rows.map((r) => ({ id: Number(r.id), clientId: r.client_id, contactId: r.contact_id, body: r.body, kind: r.kind, sendAfter: r.send_after, status: r.status }));
  },

  async markOutbox(id, status, error) {
    await query(`UPDATE iris_hs_outbox SET status = $2, error = $3, sent_at = CASE WHEN $2 IN ('sent','drafted') THEN now() ELSE sent_at END WHERE id = $1`, [id, status, error ?? null]);
  },

  async cancelPending(clientId, contactId, kinds) {
    await query(`UPDATE iris_hs_outbox SET status = 'cancelled' WHERE client_id = $1 AND contact_id = $2 AND status = 'pending' AND kind = ANY($3)`, [clientId, contactId, kinds]);
  },
};

/** In-memory store for unit tests and the offline simulation. */
export function createMemoryStore(): HsStore & { leads: Map<string, HsLead>; outbox: OutboxRow[] } {
  const leads = new Map<string, HsLead>();
  const outbox: OutboxRow[] = [];
  const key = (c: string, k: string) => `${c}:${k}`;
  let nextId = 1;
  return {
    leads,
    outbox,
    async getLead(c, k) {
      return leads.get(key(c, k)) ?? null;
    },
    async insertLead(l) {
      if (leads.has(key(l.clientId, l.contactId))) return false;
      leads.set(key(l.clientId, l.contactId), { ...l, enrolledAt: new Date() });
      return true;
    },
    async updateLead(c, k, patch) {
      const cur = leads.get(key(c, k));
      if (!cur) return;
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      leads.set(key(c, k), { ...cur, ...clean });
    },
    async listByStatus(c, status) {
      return [...leads.values()].filter((l) => l.clientId === c && l.status === status);
    },
    async dueFollowups(c, now) {
      return [...leads.values()].filter((l) => l.clientId === c && l.status === "active" && l.nextFollowupAt && l.nextFollowupAt <= now);
    },
    async enqueue(row) {
      const id = nextId++;
      outbox.push({ id, ...row, status: "pending" });
      return id;
    },
    async dueOutbox(c, now) {
      return outbox.filter((r) => r.clientId === c && r.status === "pending" && r.sendAfter <= now);
    },
    async markOutbox(id, status) {
      const row = outbox.find((r) => r.id === id);
      if (row) row.status = status;
    },
    async cancelPending(c, k, kinds) {
      for (const r of outbox) if (r.clientId === c && r.contactId === k && r.status === "pending" && kinds.includes(r.kind)) r.status = "cancelled";
    },
  };
}
