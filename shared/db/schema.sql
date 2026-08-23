-- EDEN OS shared schema. Every table carries client_id (default 'eden')
-- so Forge's ad engine can generalize to real clients later without a
-- migration — see agents/forge for the Eden-only rollout using it today.
--
-- Ported from the standalone Python ad-management system's proven SQLite
-- schema, adapted to native Postgres types (JSONB, TIMESTAMPTZ, BOOLEAN).
-- No ORM — plain SQL, matching the rest of eden-os and the system this
-- was ported from. Idempotent: safe to run on every server startup.

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
