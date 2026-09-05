import { Request, Response, Router } from "express";
import { eventBus } from "../shared/events";
import { buildEmailDeps, buildOutreachDeps } from "../agents/quarry/deps";
import { parseAppointmentContactId, parseInboundMessage } from "../agents/quarry/inbound";
import { handleEmailReply, handleReply } from "../agents/quarry/outreach";
import { getLeadByGhlContactId, updateLead } from "../agents/quarry/store";
import { loadQuarryConfig } from "../agents/quarry/config";

/**
 * GHL webhook handler.
 * Receives events when contacts are created, updated, or when
 * pipeline stages change in GoHighLevel.
 */
export function createGHLRouter(): Router {
  const router = Router();

  router.post("/contact", async (req: Request, res: Response) => {
    res.status(200).send("OK");

    // A GHL workflow's "Webhook" action wraps every custom key/value field
    // under a "customData" object rather than sending them flat — confirmed
    // against GHL's own docs, 2026-09-04, after a real workflow's webhook
    // came through with body.type undefined despite the Key literally being
    // named "type". Reading customData first (falling back to the body
    // itself) supports both that shape and a flat body from anything else
    // that posts here directly (our own test/dry-run scripts, most GHL
    // trigger payload types that AREN'T a Custom Webhook action).
    const body = req.body;
    const data = body?.customData ?? body;
    console.log(`[GHL] Contact webhook received:`, data.type || "unknown");

    try {
      switch (data.type) {
        case "ContactCreate":
          // New lead — Scout picks this up. pipelineStageId is what
          // normaliseLead's intentFromStageId actually reads to resolve
          // buyer/seller/downsize/upgrading — dropping it here silently
          // read every webhook-captured lead as "unknown" intent. Only
          // present if the GHL workflow's webhook body includes it (GHL
          // lets a workflow author customize the JSON body freely, so this
          // depends on the workflow being built to include it).
          eventBus.publish("lead.captured", "scout", data.locationId || "", {
            contactId: data.id,
            firstName: data.first_name,
            lastName: data.last_name,
            email: data.email,
            phone: data.phone,
            source: data.source,
            tags: data.tags || [],
            customFields: data.customField || {},
            pipelineStageId: data.pipelineStageId,
          });
          break;

        case "ContactUpdate":
          // Contact updated — could trigger re-scoring
          console.log(`[GHL] Contact updated: ${data.id}`);
          break;

        case "ContactTagUpdate":
          // Tags changed — could trigger nurture path changes
          console.log(`[GHL] Contact tags updated: ${data.id}`);
          break;

        default:
          console.log(`[GHL] Unhandled contact event type: ${data.type}. Raw body:`, JSON.stringify(body).slice(0, 1000));
      }
    } catch (error) {
      console.error("[GHL] Error processing webhook:", error);
    }
  });

  router.post("/opportunity", async (req: Request, res: Response) => {
    res.status(200).send("OK");

    const body = req.body;
    console.log(`[GHL] Opportunity webhook received:`, body.type || "unknown");

    try {
      switch (body.type) {
        case "OpportunityStageUpdate":
          console.log(
            `[GHL] Pipeline stage changed: ${body.id} → ${body.pipelineStageId}`
          );
          break;

        default:
          console.log(`[GHL] Unhandled opportunity event: ${body.type}`);
      }
    } catch (error) {
      console.error("[GHL] Error processing opportunity webhook:", error);
    }
  });

  /**
   * Fires when someone replies to a Quarry text or email.
   *
   * NOT wired up by GHL automatically — GHL's workflow triggers cannot be
   * created over the API (gotcha 4 in CLAUDE.md). A human has to build a thin
   * workflow in the GHL UI — trigger: an inbound reply/customer-replied event
   * — that POSTs here. Until that workflow exists, replies arrive in GHL but
   * this code never sees them.
   */
  router.post("/message", async (req: Request, res: Response) => {
    res.status(200).send("OK");

    const body = req.body;
    // Full raw body, always — this is the ground truth for fixing
    // parseInboundMessage once a real reply actually arrives.
    console.log("[QRY] inbound message webhook:", JSON.stringify(body).slice(0, 1000));

    const parsed = parseInboundMessage(body);
    if (!parsed.isInbound || !parsed.contactId || !parsed.text) {
      console.log(
        `[QRY] skipping — inbound=${parsed.isInbound} contactId=${!!parsed.contactId} text=${!!parsed.text}`
      );
      return;
    }
    if (parsed.channel === "unknown") {
      console.warn("[QRY] could not tell if this was SMS or Email — check the raw body logged above");
      return;
    }

    try {
      const lead = await getLeadByGhlContactId(parsed.contactId);
      if (!lead) return; // not a Quarry lead — not ours to handle

      const quarryConfig = loadQuarryConfig(lead.clientId);
      if (!quarryConfig) return;

      if (parsed.channel === "sms") {
        const deps = await buildOutreachDeps(lead.clientId);
        const result = await handleReply(lead, parsed.text, quarryConfig, deps);
        console.log(`[QRY] SMS reply from ${lead.name}: ${result.sentiment}`);
      } else {
        const deps = await buildEmailDeps(lead.clientId);
        const result = await handleEmailReply(lead, parsed.text, quarryConfig, deps);
        console.log(`[QRY] Email reply from ${lead.name}: ${result.sentiment}`);
      }
    } catch (error) {
      console.error("[QRY] failed to process inbound reply:", error);
    }
  });

  /**
   * Fires when someone actually books a call off a Quarry pitch's booking
   * link.
   *
   * Same gotcha as /message — GHL workflow triggers cannot be created over
   * the API (gotcha 4 in CLAUDE.md). A human has to build a thin workflow in
   * GHL's UI — trigger: a booked appointment on the calendar Quarry's pitch
   * links to — that POSTs contactId here. Until that workflow exists, a
   * booking happens in GHL and nothing here ever sees it, so the pipeline
   * stage sits at "Replied Interest" forever even after a real call lands
   * on the calendar.
   *
   * UNVERIFIED against a live payload — this repo has never received a real
   * one. Logs the full raw body on every hit so the first real booking gives
   * ground truth immediately, same as /message.
   */
  router.post("/appointment", async (req: Request, res: Response) => {
    res.status(200).send("OK");

    const body = req.body;
    console.log("[QRY] inbound appointment webhook:", JSON.stringify(body).slice(0, 1000));

    const contactId = parseAppointmentContactId(body);
    if (!contactId) {
      console.warn("[QRY] appointment webhook had no resolvable contactId — check the raw body logged above");
      return;
    }

    try {
      const lead = await getLeadByGhlContactId(contactId);
      if (!lead) return; // not a Quarry lead — not ours to handle
      if (!lead.ghlOpportunityId) {
        console.warn(`[QRY] ${lead.name} booked but has no ghlOpportunityId — cannot move its stage`);
        return;
      }

      const deps = await buildOutreachDeps(lead.clientId);
      await deps.moveStage(lead.ghlOpportunityId, "Call Booked");
      // Local pipelineStage, not just the GHL opportunity — this is what
      // handleReply/handleEmailReply check to stop treating a reply to a
      // booking confirmation/reminder as a reply to the original pitch.
      await updateLead(lead.id, { pipelineStage: "Call Booked" });
      console.log(`[QRY] ${lead.name} booked a call — moved to "Call Booked"`);
    } catch (error) {
      console.error("[QRY] failed to process appointment booking:", error);
    }
  });

  return router;
}
