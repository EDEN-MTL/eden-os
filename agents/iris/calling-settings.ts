import { query } from "../../shared/db";

/** ad_settings key for Iris's calling kill switch. */
const CALLING_ENABLED_KEY = "iris_calling_enabled";

/**
 * Reads iris_calling_enabled fresh from the database on every call, same
 * idiom as Forge's emergency_hold_all (agents/forge/ads/settings.ts) —
 * never cached, so flipping it takes effect without a redeploy. Unlike
 * emergency_hold_all, this defaults to `false`: placing a phone call costs
 * real per-minute money the moment Vapi answers, so a fresh install or an
 * unset flag must fail safe as DISABLED, not enabled.
 */
export async function isCallingEnabled(clientId = "eden"): Promise<boolean> {
  const rows = await query<{ value: string }>(
    "SELECT value FROM ad_settings WHERE client_id = $1 AND key = $2",
    [clientId, CALLING_ENABLED_KEY]
  );
  if (rows.length === 0) return false;
  return ["1", "true", "yes", "on"].includes(rows[0].value.toLowerCase());
}

export async function setCallingEnabled(enabled: boolean, clientId = "eden"): Promise<void> {
  await query(
    `INSERT INTO ad_settings (client_id, key, value, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (client_id, key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [clientId, CALLING_ENABLED_KEY, enabled ? "true" : "false"]
  );
}
