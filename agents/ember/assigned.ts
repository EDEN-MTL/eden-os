/**
 * Is this lead assigned to an agent? Jacob, 2026-11-19: Ember reactivated and texted Sabrina Marie (assigned to Justin
 * Penney, tagged live transferred) as if she were a cold inquiry — "if they are assigned to an agent, the AI leaves
 * them alone." Read live from the contact and the card, because assignment changes without any event Ember sees.
 * A read that fails answers null: a reply from a lead is never left unanswered because GHL hiccuped.
 */
import { getContact, getGhlConfig, getOpportunity, listLocationUsers } from "../../shared/ghl";
import { NurtureLead } from "./types";

export async function assignedAgentName(lead: NurtureLead): Promise<string | null> {
  try {
    const ghl = await getGhlConfig(lead.clientId);
    if (!ghl) return null;
    const payload = await getContact(lead.ghlContactId, ghl.locationId, ghl.apiKey);
    let assigned: string | null = (payload?.contact ?? payload)?.assignedTo || null;
    if (!assigned && lead.ghlOpportunityId) {
      const opp = await getOpportunity(lead.ghlOpportunityId, ghl.locationId, ghl.apiKey).catch(() => null);
      assigned = opp?.assignedTo || null;
    }
    if (!assigned) return null;
    const users = await listLocationUsers(ghl.locationId, ghl.apiKey).catch(() => []);
    return users.find((u: { id: string; name?: string }) => u.id === assigned)?.name ?? "an agent";
  } catch (error) {
    console.error(`[EMB] could not check whether ${lead.ghlContactId} is assigned:`, error instanceof Error ? error.message : error);
    return null;
  }
}
