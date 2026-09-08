/**
 * Sends a SAMPLE bi-weekly appointment digest as Scout, with fabricated
 * names/appointments — a format/look preview only, not real data. Posts to
 * a channel by NAME (looked up via conversations.list, since chat.postMessage
 * needs a channel ID and no test-channel resolver exists yet).
 *
 * In production this same block layout would post to each client's own
 * channel (config/clients/<id>.json's `slack.clientChannel`), sourced from
 * real GHL appointment data — that pipeline doesn't exist yet; see
 * .claude/plans/quirky-doodling-nygaard.md for the follow-up scope.
 *
 *   npx tsx scripts/send-sample-biweekly-digest.ts [channelName]
 *
 * channelName defaults to "backend-ops".
 */
import "dotenv/config";
import { initSlackClients, getClient } from "../shared/slack";

const FAKE_LEADS = [
  { name: "Priya Nandakumar", propertyType: "Detached 4-bed", rep: "Jordan", daysAgo: 2 },
  { name: "Marcus Whitfield", propertyType: "Condo 2-bed", rep: "Sam", daysAgo: 4 },
  { name: "Elena Voskresenskaya", propertyType: "Townhouse", rep: "Jordan", daysAgo: 6 },
  { name: "Tobias Ackerman", propertyType: "Detached 3-bed", rep: "Priya R.", daysAgo: 9 },
  { name: "Fatima Al-Rashid", propertyType: "Condo 1-bed", rep: "Sam", daysAgo: 11 },
];

function formatDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function buildBlocks(): any[] {
  const today = new Date();
  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(today.getDate() - 14);
  const rangeLabel = `${twoWeeksAgo.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${today.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "📋 Bi-Weekly Appointment Check-in", emoji: true },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*${rangeLabel}* · SAMPLE DATA — for format review only, not real appointments` },
      ],
    },
    { type: "divider" },
  ];

  for (const lead of FAKE_LEADS) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${lead.name}* — ${lead.propertyType}\n📅 ${formatDate(lead.daysAgo)}  ·  👤 ${lead.rep}\n*Outcome:* _reply below with what happened_`,
      },
    });
  }

  blocks.push(
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Team leads: reply in this thread with an update for each appointment above (e.g. \"Priya — showed up, going for a second viewing\"). Scout will follow up on anything still unanswered.",
        },
      ],
    }
  );

  return blocks;
}

async function main() {
  const arg = (process.argv[2] || "backend-ops").replace(/^#/, "");
  // A raw Slack channel/group ID (C.../G...) skips the name lookup entirely —
  // Scout's bot token doesn't have the channels:read/groups:read scope
  // conversations.list needs, so resolving a #name requires that scope to be
  // granted first. Passing the ID directly avoids that dependency.
  const isChannelId = /^[CG][A-Z0-9]{8,}$/.test(arg);

  initSlackClients();
  const client = getClient("scout");

  let channelId: string | undefined = isChannelId ? arg : undefined;

  if (!channelId) {
    console.log(`[SAMPLE] Looking up channel "#${arg}"...`);
    try {
      for await (const page of client.paginate("conversations.list", {
        types: "public_channel,private_channel",
        limit: 200,
      }) as any) {
        const match = (page.channels || []).find((c: any) => c.name === arg);
        if (match) {
          channelId = match.id;
          break;
        }
      }
    } catch (error) {
      console.error(
        `[SAMPLE] Couldn't look up "#${arg}" by name (${(error as Error).message}). ` +
          `Pass the channel ID directly instead, e.g.:\n` +
          `  npx tsx scripts/send-sample-biweekly-digest.ts C0123ABC456`
      );
      process.exit(1);
    }
  }

  if (!channelId) {
    console.error(
      `[SAMPLE] Could not find a channel named "#${arg}" that Scout's bot can see. ` +
        `Make sure Scout's bot is invited to that channel, then re-run.`
    );
    process.exit(1);
  }

  const blocks = buildBlocks();
  const response = await client.chat.postMessage({
    channel: channelId,
    text: "Bi-weekly appointment check-in (sample)",
    blocks,
    unfurl_links: false,
  });

  console.log(`[SAMPLE] Posted to channel ${channelId}, ts=${response.ts}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[SAMPLE] Failed to send sample digest:", error);
  process.exit(1);
});
