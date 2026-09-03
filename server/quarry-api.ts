/**
 * Quarry's HTTP surface.
 *
 * The image route is deliberately UNAUTHENTICATED. An MMS attachment is
 * fetched by the carrier's media gateway, not by a logged-in browser, so a
 * dashboard-key check here would mean every message sends with no image —
 * and GHL reports that as a success, so it would look like it worked.
 *
 * The ids are sequential, so the route is enumerable. What it exposes is a
 * screenshot of a website we built for a business from public listings; there
 * is nothing private in it. Anything that is not that must not go in this
 * table.
 */
import express, { Router } from "express";
import { readImage } from "../agents/quarry/screenshot";
import { unsubscribeByToken } from "../agents/quarry/store";

export function createQuarryRouter(): Router {
  const router = express.Router();

  router.get("/images/:id.png", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "bad image id" });
      return;
    }
    try {
      const image = await readImage(id);
      if (!image) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.setHeader("Content-Type", image.contentType);
      // Long cache: the bytes for an id never change, and carrier gateways
      // re-fetch aggressively across retries and forwards.
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.send(image.bytes);
    } catch (error) {
      console.error("[QRY] image read failed:", error);
      res.status(500).json({ error: "image read failed" });
    }
  });

  // CASL requires a working unsubscribe mechanism in every commercial email.
  // GET rather than POST because the client is a link in an email, not a
  // form — no browser follows a mailto-adjacent link with a POST. The token
  // is an opaque UUID (see insertDiscovered), not the lead's numeric id, so
  // this route cannot be used to opt some OTHER lead out by editing the URL.
  router.get("/unsubscribe/:token", async (req, res) => {
    const ok = await unsubscribeByToken(req.params.token).catch((error) => {
      console.error("[QRY] unsubscribe failed:", error);
      return null;
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (ok === null) {
      res.status(500).send("<p>Something went wrong. Please try again later.</p>");
      return;
    }
    // Same response whether the token matched or not — confirming a token is
    // valid/invalid to an anonymous requester is not something this route
    // should reveal either way.
    res.send("<p>You have been unsubscribed and will not receive further emails.</p>");
  });

  return router;
}
