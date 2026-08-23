import { query } from "../../../shared/db";

/**
 * Reads emergency_hold_all fresh from the database on every call, never
 * cached — this is the master kill switch. A long-running process (the
 * scheduler) builds its rules engine once and reuses it for days; if this
 * were read once at startup, flipping it from the dashboard would
 * silently do nothing until the process restarted. Defaults to `true`
 * (hold everything) if unset, so a fresh install fails safe.
 */
export async function readEmergencyHoldAll(clientId = "eden"): Promise<boolean> {
  const rows = await query<{ value: string }>(
    "SELECT value FROM ad_settings WHERE client_id = $1 AND key = 'emergency_hold_all'",
    [clientId]
  );
  if (rows.length === 0) return true;
  return ["1", "true", "yes", "on"].includes(rows[0].value.toLowerCase());
}

export async function writeEmergencyHoldAll(value: boolean, clientId = "eden"): Promise<void> {
  await query(
    `INSERT INTO ad_settings (client_id, key, value, updated_at)
     VALUES ($1, 'emergency_hold_all', $2, now())
     ON CONFLICT (client_id, key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [clientId, value ? "true" : "false"]
  );
}
