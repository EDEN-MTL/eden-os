/**
 * The scheduled send run: every due nurture touch for one client, inside
 * the local send window, under the daily cap. This is the only place Ember
 * puts a message in front of a real person, and it refuses outright while
 * ember.enabled is false.
 */
import { EmberConfigError, loadEmberConfig, loadEmberOutcomeStages, validateForSending } from "./config";
import { buildOutreachDeps, resolveStageNames } from "./deps";
import { BatchResult, inSendWindow, OutreachDeps, sendBatch } from "./outreach";
import { listDue } from "./store";
import { readFileSync } from "fs";
import { join } from "path";

export class EmberDisabledError extends Error {
  constructor(clientId: string) {
    super(
      `ember.enabled is false for "${clientId}" — nothing is sent until it's flipped on ` +
        `(scripts/enable-ember-nurture.ts, after the cost is confirmed with Jacob).`
    );
    this.name = "EmberDisabledError";
  }
}

/**
 * Clients with a send run in flight. A full batch at the default spacing
 * (90s + up to 120s jitter, 20/day cap) runs over an hour, and the
 * scheduler fires every 30 minutes — without this, a second run would read
 * the same due rows before the first had sent to them and text people
 * twice. In-process is enough: every agent runs in one Node process.
 */
const inFlight = new Set<string>();

export type SendRunResult =
  | { ran: false; reason: string }
  | ({ ran: true; due: number } & BatchResult);

function clientName(clientId: string): string {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "config", "clients", `${clientId}.json`), "utf-8"))?.clientName || clientId;
  } catch {
    return clientId;
  }
}

export async function sendPendingForClient(
  clientId: string,
  options: {
    now?: Date;
    /** Skips the send-window check — only for an explicit human "send now". */
    ignoreSendWindow?: boolean;
    deps?: OutreachDeps;
    stageNames?: Record<string, string>;
    log?: (line: string) => void;
  } = {}
): Promise<SendRunResult> {
  const config = loadEmberConfig(clientId);
  if (!config) throw new Error(`No ember config for client "${clientId}"`);
  if (!config.enabled) throw new EmberDisabledError(clientId);

  const problems = validateForSending(config);
  if (problems.length) throw new EmberConfigError(problems);

  const now = options.now ?? new Date();
  if (!options.ignoreSendWindow && !inSendWindow(now, config)) {
    return { ran: false, reason: `outside the ${config.sendWindow.startHour}:00–${config.sendWindow.endHour}:00 ${config.timezone} send window` };
  }

  if (inFlight.has(clientId)) return { ran: false, reason: "a send run is already in progress" };
  inFlight.add(clientId);
  try {
    const due = await listDue(clientId, now);
    if (due.length === 0) return { ran: false, reason: "no touches due" };

    const deps = options.deps ?? (await buildOutreachDeps(clientId, config));
    const stageNames = options.stageNames ?? (await resolveStageNames(clientId, config.pipelineId));
    const result = await sendBatch(
      due,
      deps,
      { config, clientName: clientName(clientId), outcomeStages: loadEmberOutcomeStages(clientId), stageNames, now },
      { log: options.log, clock: options.now ? () => now : () => new Date(), ignoreSendWindow: options.ignoreSendWindow }
    );
    return { ran: true, due: due.length, ...result };
  } finally {
    inFlight.delete(clientId);
  }
}
