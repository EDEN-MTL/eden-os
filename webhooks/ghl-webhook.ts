import { Request, Response, Router } from "express";
import { eventBus } from "../shared/events";
import { buildEmailDeps, buildOutreachDeps } from "../agents/quarry/deps";
import { parseInboundMessage } from "../agents/quarry/inbound";
import { handleEmailReply, handleReply } from "../agents/quarry/outreach";
import { getLeadByGhlContactId } from "../agents/quarry/store";
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

    const body = req.body;
    console.log(`[GHL] Contact webhook received:`, body.type || "unknown");

    try {
      switch (body.type) {
        case "ContactCreate":
          // New lead — Scout picks this up. pipelineStageId is what
          // normaliseLead's intentFromStageId actually reads to resolve
          // buyer/seller/downsize/upgrading — dropping it here silently
          // read every webhook-captured lead as "unknown" intent. Only
          // present if the GHL workflow's webhook body includes it (GHL
          // lets a workflow author customize the JSON body freely, so this
          // depends on the workflow being built to include it).
          eventBus.publish("lead.captured", "scout", body.locationId || "", {
            contactId: body.id,
            firstName: body.first_name,
            lastName: body.last_name,
            email: body.email,
            phone: body.phone,
            source: body.source,
            tags: body.tags || [],
            customFields: body.customField || {},
            pipelineStageId: body.pipelineStageId,
          });
          break;

        case "ContactUpdate":
          // Contact updated — could trigger re-scoring
          console.log(`[GHL] Contact updated: ${body.id}`);
          break;

        case "ContactTagUpdate":
          // Tags changed — could trigger nurture path changes
          console.log(`[GHL] Contact tags updated: ${body.id}`);
          break;

        default:
          console.log(`[GHL] Unhandled contact event type: ${body.type}`);
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

  return router;
}
