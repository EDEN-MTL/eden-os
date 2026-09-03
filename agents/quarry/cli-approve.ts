/**
 * Temporary stopgap for approving/rejecting leads — until the real console
 * exists. Every send in this agent is gated on approval_status = 'approved',
 * and nothing currently sets that except editing the database by hand. This
 * is that, through one narrow command instead of a raw SQL statement that
 * could touch the wrong row.
 *
 *   npm run quarry:approve -- --list-pending
 *   npm run quarry:approve -- --id 12
 *   npm run quarry:approve -- --id 12 --reject
 *   npm run quarry:approve -- --all-pending
 */
import "dotenv/config";
import { getLead, listLeads, updateLead } from "./store";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

async function main() {
  const clientId = arg("client") ?? "eden";

  if (has("list-pending")) {
    const pending = await listLeads({ clientId, approvalStatus: "pending" });
    console.log(`\n${pending.length} pending lead(s):\n`);
    for (const l of pending) {
      console.log(
        `  #${l.id}  ${l.name.padEnd(30)}  ${(l.category ?? "uncategorised").padEnd(16)}  ` +
          `${l.email ?? "no email"}  — ${l.reasons.join("; ")}`
      );
    }
    console.log("");
    process.exit(0);
  }

  const status: "approved" | "rejected" = has("reject") ? "rejected" : "approved";
  const id = arg("id");
  const allPending = has("all-pending");

  if (!id && !allPending) {
    console.log("Usage:");
    console.log("  npm run quarry:approve -- --list-pending");
    console.log("  npm run quarry:approve -- --id <leadId> [--reject]");
    console.log("  npm run quarry:approve -- --all-pending [--reject]");
    process.exit(1);
  }

  if (id) {
    const lead = await getLead(Number(id));
    if (!lead) {
      console.error(`No lead #${id}`);
      process.exit(1);
    }
    await updateLead(lead.id, { approvalStatus: status });
    console.log(`#${lead.id} ${lead.name} → ${status}`);
  } else {
    const pending = await listLeads({ clientId, approvalStatus: "pending" });
    for (const l of pending) await updateLead(l.id, { approvalStatus: status });
    console.log(`${pending.length} lead(s) → ${status}`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
