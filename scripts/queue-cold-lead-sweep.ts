/**
 * Lines up a one-shot Iris call for a hand-picked list of old, cold leads
 * (Mark, 2026-10-07): npx tsx scripts/queue-cold-lead-sweep.ts <clientId> <startInMinutes> <contactId...>
 * Prints exactly what it queued. Nothing is dialed here — the dial scheduler
 * picks the rows up when they're due, one call at a time, each only after the
 * previous one has ended.
 */
import "dotenv/config";
import { queueColdLeadSweep } from "../agents/iris/dial-pending";
import { initSlackClients, sendMessage } from "../shared/slack";

async function main() {
  const [clientId, startIn, ...contactIds] = process.argv.slice(2);
  if (!clientId || !startIn || contactIds.length === 0) {
    console.error("usage: queue-cold-lead-sweep.ts <clientId> <startInMinutes> <contactId...>");
    process.exit(1);
  }
  const startAt = new Date(Date.now() + Number(startIn) * 60_000);
  const queued = await queueColdLeadSweep(clientId, contactIds, startAt);
  for (const q of queued) console.log(`${q.callAfter.toISOString()}  ${q.name} (${q.contactId})`);
  console.log(`queued ${queued.length} of ${contactIds.length}`);

  // Mark, 2026-10-07: these calls are monitored in #iris-call-logs, so say up
  // front which leads are lined up and in what order.
  if (queued.length > 0) {
    initSlackClients();
    await sendMessage("iris", {
      channel: process.env.IRIS_CALL_LOG_CHANNEL || "iris-call-logs",
      text:
        `📋 Cold-lead sweep lined up — ${queued.length} calls, one at a time (each starts after the previous one ends; ` +
        `no voicemail is left, and a lead who doesn't pick up gets one text):\n` +
        queued.map((q, i) => `${i + 1}. ${q.name}`).join("\n"),
    });
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
