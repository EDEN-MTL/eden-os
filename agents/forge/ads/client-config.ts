/**
 * Reads the per-client stage mapping out of config/clients/{clientId}.json.
 *
 * Lives here rather than inside sync.ts because both the sync path (which
 * decides won/lost per opportunity) and the reporting path (which totals
 * pipeline value) need the same mapping, and they must not drift apart —
 * if sync classifies a stage as won but the report doesn't, the numbers
 * disagree with no obvious cause.
 */
import { readFileSync } from "fs";
import { join } from "path";
import type { OutcomeStageMap } from "./attribution";

/**
 * Returns undefined when unconfigured, which leaves deriveWon relying on
 * GHL's status field alone and pipeline value reading as zero.
 */
export function loadOutcomeStages(clientId: string): OutcomeStageMap | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8")
    );
    const stages = raw?.ghl?.outcomeStages;
    if (!stages) return undefined;
    return stages.wonStages || stages.lostStages || stages.activeStages ? stages : undefined;
  } catch {
    return undefined;
  }
}
