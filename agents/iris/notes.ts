/**
 * Reads the client's own callbackNotesFieldKey field on a contact and
 * appends one more line to it — never overwrites, since this field can
 * already carry a real qualification summary or an earlier call's status
 * line that matters just as much as whatever's being added now. Shared by
 * the post-call status line and missed-callback notes (webhooks/vapi-webhook.ts)
 * and by callbacks a lead asks for over text (agents/iris/sms.ts).
 */
import { getGhlConfig, getContact, getCustomFieldDefs, updateContact } from "../../shared/ghl";
import { buildKeyToId, readField } from "../scout/intake";
import { loadIrisConfig } from "./index";

export async function appendNoteToContact(clientId: string, contactId: string, line: string): Promise<void> {
  const ghlConfig = await getGhlConfig(clientId);
  const config = loadIrisConfig(clientId);
  if (!ghlConfig || !config) return;

  const defs = await getCustomFieldDefs(ghlConfig.locationId, ghlConfig.apiKey);
  const keyToId = buildKeyToId(defs);
  const fieldId = keyToId.get(config.callbackNotesFieldKey);
  if (!fieldId) {
    console.warn(`[VAPI] callbackNotesFieldKey "${config.callbackNotesFieldKey}" did not resolve to a field id for ${clientId} — skipping note.`);
    return;
  }

  const contactResp = await getContact(contactId, ghlConfig.locationId, ghlConfig.apiKey);
  const contact = contactResp?.contact ?? contactResp;
  const existing = readField(contact?.customFields, config.callbackNotesFieldKey, keyToId);
  const notes = existing ? `${existing}\n\n${line}` : line;

  await updateContact(contactId, { customFields: [{ id: fieldId, value: notes }] }, ghlConfig.locationId, ghlConfig.apiKey);
}

