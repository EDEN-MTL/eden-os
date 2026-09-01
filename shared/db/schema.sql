-- EDEN OS shared schema. Every table carries client_id (default 'eden')
-- so Forge's ad engine can generalize to real clients later without a
-- migration — see agents/forge for the Eden-only rollout using it today.
--
-- Ported from the standalone Python ad-management system's proven SQLite
-- schema, adapted to native Postgres types (JSONB, TIMESTAMPTZ, BOOLEAN).
-- No ORM — plain SQL, matching the rest of eden-os and the system this
-- was ported from. Idempotent: safe to run on every server startup.

-- Live-toggleable flags (the emergency_hold_all kill switch, and anything
-- similar later). The Python prototype this was ported from stored this in
-- a local .env file it re-read on every check, so flipping it from the
-- dashboard took effect without a restart. Render doesn't support that —
-- env vars are injected at container start, not read live from a file —
-- so this table is the direct equivalent: read fresh on every rules-engine
-- evaluation, writable from the dashboard with no redeploy needed.
CREATE TABLE IF NOT EXISTS ad_settings (
    client_id TEXT NOT NULL DEFAULT 'eden',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, key)
);

-- Static integration credentials entered via the dashboard's Settings
-- page — the seed inputs a human provides (app id/secret, seed access
-- token, ad account id). Distinct from meta_tokens below, which holds the
-- auto-refreshed *live* token state auth.ts manages on its own. Never
-- returned to the browser after being saved — the settings API only ever
-- reports "configured" / "not configured".
CREATE TABLE IF NOT EXISTS meta_credentials (
    client_id TEXT PRIMARY KEY DEFAULT 'eden',
    app_id TEXT NOT NULL,
    app_secret TEXT NOT NULL,
    access_token TEXT NOT NULL,
    ad_account_id TEXT NOT NULL,
    page_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ghl_credentials (
    client_id TEXT PRIMARY KEY DEFAULT 'eden',
    api_key TEXT NOT NULL,
    location_id TEXT NOT NULL,
    attribution_pipeline_name TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meta_tokens (
    client_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    token_type TEXT NOT NULL DEFAULT 'long_lived',
    expires_at TIMESTAMPTZ,
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meta_performance_snapshots (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL DEFAULT 'eden',
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    date_start DATE NOT NULL,
    date_stop DATE NOT NULL,
    level TEXT NOT NULL,              -- campaign | adset | ad
    campaign_id TEXT,
    campaign_name TEXT,
    adset_id TEXT,
    adset_name TEXT,
    ad_id TEXT,
    ad_name TEXT,
    spend DOUBLE PRECISION NOT NULL DEFAULT 0,
    impressions BIGINT NOT NULL DEFAULT 0,
    clicks BIGINT NOT NULL DEFAULT 0,
    ctr DOUBLE PRECISION,
    cpc DOUBLE PRECISION,
    reach BIGINT,
    frequency DOUBLE PRECISION,
    raw JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perf_entity ON meta_performance_snapshots(level, campaign_id, adset_id, ad_id);
CREATE INDEX IF NOT EXISTS idx_perf_window ON meta_performance_snapshots(date_start, date_stop);
CREATE INDEX IF NOT EXISTS idx_perf_client ON meta_performance_snapshots(client_id);

CREATE TABLE IF NOT EXISTS ad_leads (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL DEFAULT 'eden',
    ghl_contact_id TEXT NOT NULL,
    fbclid TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,
    meta_campaign_id TEXT,
    meta_adset_id TEXT,
    meta_ad_id TEXT,
    pipeline_stage TEXT,
    deal_value DOUBLE PRECISION,
    won BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw JSONB,
    UNIQUE (client_id, ghl_contact_id)
);
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON ad_leads(meta_campaign_id, meta_adset_id, meta_ad_id);

-- Rules live in the database (not YAML) so the dashboard can toggle
-- auto_execute/enabled live, no deploy required.
CREATE TABLE IF NOT EXISTS ad_rules (
    id TEXT NOT NULL,
    client_id TEXT NOT NULL DEFAULT 'eden',
    name TEXT NOT NULL,
    scope TEXT NOT NULL,               -- campaign | adset | ad
    metric TEXT NOT NULL,              -- cpl | roas | ctr | cpc | spend | frequency | lead_count
    operator TEXT NOT NULL,            -- gt | gte | lt | lte
    threshold DOUBLE PRECISION NOT NULL,
    action JSONB NOT NULL,             -- {"type": "pause"} | {"type": "increase_budget", "percent": 20, ...}
    auto_execute BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    min_spend DOUBLE PRECISION NOT NULL DEFAULT 0,
    lookback_days INTEGER NOT NULL DEFAULT 3,
    cooldown_hours INTEGER NOT NULL DEFAULT 24,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, id)
);

CREATE TABLE IF NOT EXISTS ad_rule_cooldowns (
    client_id TEXT NOT NULL DEFAULT 'eden',
    rule_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    last_triggered_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (client_id, rule_id, entity_id)
);

CREATE TABLE IF NOT EXISTS ad_pending_actions (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL DEFAULT 'eden',
    rule_id TEXT NOT NULL,
    rule_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,         -- campaign | adset | ad
    entity_id TEXT NOT NULL,
    entity_name TEXT,
    action_type TEXT NOT NULL,         -- pause | resume | set_budget | create_adset | create_ad | notify_only
    action_payload JSONB NOT NULL,
    reasoning TEXT NOT NULL,
    metrics_snapshot JSONB NOT NULL,
    auto_execute_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|executed|failed|expired
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    decided_by TEXT,                    -- slack user, 'cli:<user>', or 'auto'
    executed_at TIMESTAMPTZ,
    slack_channel TEXT,
    slack_message_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON ad_pending_actions(client_id, status);

CREATE TABLE IF NOT EXISTS ad_audit_log (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL DEFAULT 'eden',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor TEXT NOT NULL,                -- 'rule:<rule_id>' | 'human:<who>' | 'system'
    rule_id TEXT,
    action_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_name TEXT,
    auto_executed BOOLEAN NOT NULL DEFAULT FALSE,
    pending_action_id BIGINT REFERENCES ad_pending_actions(id),
    before_state JSONB,
    after_state JSONB,
    result TEXT NOT NULL,               -- success | failure | rejected | held
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON ad_audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON ad_audit_log(client_id, timestamp);

-- The marketing brief behind a campaign, captured at creation time so the
-- creative-testing engine can draft fresh angles later without a human
-- re-typing context.
CREATE TABLE IF NOT EXISTS ad_campaign_briefs (
    client_id TEXT NOT NULL DEFAULT 'eden',
    campaign_id TEXT NOT NULL,
    offer TEXT,
    audience TEXT,
    objective TEXT,
    tone TEXT,
    country TEXT,
    special_ad_category TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, campaign_id)
);

-- One row per creative-testing cycle: which ad set is the current "test"
-- set, and whether a winner has been found/locked/scaled. `generation`
-- increments each time the strategy duplicates into a fresh test ad set.
CREATE TABLE IF NOT EXISTS ad_creative_tests (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL DEFAULT 'eden',
    campaign_id TEXT NOT NULL,
    adset_id TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'testing', -- testing | winner_locked | scaled
    winner_ad_id TEXT,
    parent_adset_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, adset_id)
);
CREATE INDEX IF NOT EXISTS idx_creative_tests_campaign ON ad_creative_tests(client_id, campaign_id);

-- Content planning Kanban — spans both Eden's own brand voice and, later,
-- per-client content.
CREATE TABLE IF NOT EXISTS content_items (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL DEFAULT 'eden',
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idea',        -- idea | in_progress | ready | posted
    brand_voice TEXT NOT NULL DEFAULT 'eden',
    platform TEXT,                                -- instagram | tiktok | youtube | linkedin | x
    bucket TEXT,                                   -- growth | authority | conversion | personal
    hook TEXT,
    copy TEXT,
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual',         -- manual | fathom_agent
    source_meeting_id TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    scheduled_date DATE,
    posted_at TIMESTAMPTZ,
    results JSONB,                                 -- {views, likes, comments, shares, saves, link_clicks, notes}
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_status ON content_items(client_id, status, position);
CREATE INDEX IF NOT EXISTS idx_content_platform ON content_items(platform, brand_voice);

-- Which Fathom call transcripts the content-idea agent already processed,
-- so a scheduled run doesn't re-analyze the same call twice.
CREATE TABLE IF NOT EXISTS fathom_meetings_processed (
    fathom_meeting_id TEXT PRIMARY KEY,
    title TEXT,
    recorded_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ideas_generated INTEGER NOT NULL DEFAULT 0
);

-- ─────────────────────────────────────────────────────────────────────
-- QUARRY — prospecting + speculative site generation.
--
-- Module 0 of the "bad website finder" spec called for a separate Supabase
-- instance. It lives here instead: eden-os already runs Postgres on Render,
-- already holds GHL credentials per client, and the console already has a
-- login. A second database would have meant a second GHL client and a
-- second set of the field-id gotchas in CLAUDE.md.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quarry_leads (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL DEFAULT 'eden',
    place_id TEXT NOT NULL,
    name TEXT NOT NULL,
    formatted_address TEXT,
    phone TEXT,
    -- Raw provider string ("mobile" | "landline" | "fixedVoip" | ...), kept
    -- verbatim rather than collapsed to the boolean, because VOIP results are
    -- a human-decision bucket and the distinction is lost once flattened.
    phone_line_type TEXT,
    is_mobile BOOLEAN,
    email TEXT,
    email_source TEXT,                              -- own_website_contact_page
    has_public_email BOOLEAN NOT NULL DEFAULT FALSE,
    website TEXT,
    category TEXT,                                  -- maps to a design brief
    search_query TEXT,                              -- which config query surfaced it
    rating DOUBLE PRECISION,
    user_ratings_total INTEGER,
    business_status TEXT,
    photo_refs JSONB NOT NULL DEFAULT '[]'::jsonb,  -- Places photo references
    is_candidate BOOLEAN,
    reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    outdated_score INTEGER,                         -- 1-10, Claude vision
    outdated_reasoning TEXT,
    preview_url TEXT,
    preview_image_url TEXT,
    generator TEXT,                                 -- which SiteGenerator built it
    generation_error TEXT,
    ghl_contact_id TEXT,
    ghl_opportunity_id TEXT,
    pipeline_stage TEXT,
    approval_status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
    -- The pipeline never sets this. It exists because unsolicited commercial
    -- texts in Canada sit under the CRTC's Unsolicited Telecommunications
    -- Rules as well as CASL, and the National DNCL is not something GHL
    -- screens for you. A human ticks it, or a future DNCL integration does.
    dncl_checked BOOLEAN NOT NULL DEFAULT FALSE,
    -- Set when a lead is held out of the SMS path (landline/VOIP) so it can
    -- be worked by call or email instead of silently disappearing.
    holdout_reason TEXT,
    sent_at TIMESTAMPTZ,
    replied_at TIMESTAMPTZ,
    last_lookup_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, place_id)
);
CREATE INDEX IF NOT EXISTS idx_quarry_stage ON quarry_leads(client_id, pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_quarry_approval ON quarry_leads(client_id, approval_status);
CREATE INDEX IF NOT EXISTS idx_quarry_category ON quarry_leads(client_id, category);

CREATE TABLE IF NOT EXISTS quarry_runs (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL DEFAULT 'eden',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',         -- running|ok|failed
    leads_found INTEGER NOT NULL DEFAULT 0,
    leads_qualified INTEGER NOT NULL DEFAULT 0,
    leads_mobile INTEGER NOT NULL DEFAULT 0,
    leads_generated INTEGER NOT NULL DEFAULT 0,
    leads_screenshotted INTEGER NOT NULL DEFAULT 0,
    leads_synced INTEGER NOT NULL DEFAULT 0,
    -- [{ step, placeId, name, message, at }] — one entry per skipped lead.
    -- A lead that fails generation must not take the batch down with it.
    errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    triggered_by TEXT NOT NULL DEFAULT 'schedule'   -- schedule|dashboard|cli
);
CREATE INDEX IF NOT EXISTS idx_quarry_runs_started ON quarry_runs(client_id, started_at DESC);

CREATE TABLE IF NOT EXISTS quarry_send_log (
    id BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL DEFAULT 'eden',
    lead_id BIGINT NOT NULL REFERENCES quarry_leads(id) ON DELETE CASCADE,
    step TEXT NOT NULL,                             -- screenshot|link|nudge
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    message_content TEXT NOT NULL,
    attachment_url TEXT,
    ghl_message_id TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_quarry_send_day ON quarry_send_log(client_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_quarry_send_lead ON quarry_send_log(lead_id, step);

CREATE TABLE IF NOT EXISTS quarry_design_briefs (
    client_id TEXT NOT NULL DEFAULT 'eden',
    category TEXT NOT NULL,                         -- trade-service | retail-boutique | professional
    label TEXT NOT NULL,
    brief_markdown TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, category)
);

-- Carrier lookups are billable and a business's line type effectively never
-- changes, so they're cached by number rather than by lead — the same shop
-- resurfacing under a second search query costs nothing the second time.
CREATE TABLE IF NOT EXISTS quarry_phone_lookups (
    phone TEXT PRIMARY KEY,
    line_type TEXT NOT NULL,
    is_mobile BOOLEAN NOT NULL,
    carrier TEXT,
    provider TEXT NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw JSONB
);

-- Durable conversation memory. Before this, BaseAgent kept history in an
-- in-process Map — wiped on every deploy, and this system deploys often.
-- Slack/dashboard chat is the actual interface people use, so an agent
-- forgetting every conversation each time the server restarted meant
-- nothing ever felt remembered. history_key matches whatever BaseAgent
-- already used as the in-memory map key (a Slack DM/channel+thread, or a
-- dashboard session id) — same shape, just durable now.
CREATE TABLE IF NOT EXISTS agent_conversations (
    id BIGSERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL,
    history_key TEXT NOT NULL,
    role TEXT NOT NULL,                             -- user | assistant
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_lookup ON agent_conversations(agent_id, history_key, id);
