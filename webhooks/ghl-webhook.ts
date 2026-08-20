import { Request, Response, Router } from "express";
import { eventBus } from "../shared/events";

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
          // New lead — Scout picks this up
          eventBus.publish("lead.captured", "scout", body.locationId || "", {
            contactId: body.id,
            firstName: body.first_name,
            lastName: body.last_name,
            email: body.email,
            phone: body.phone,
            source: body.source,
            tags: body.tags || [],
            customFields: body.customField || {},
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

  return router;
}
