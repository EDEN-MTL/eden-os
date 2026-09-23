/**
 * Ember's HTTP surface — only the CASL unsubscribe link for now. Same
 * reasoning as the one in quarry-api.ts: GET because the client is a link
 * in an email, and the token is an opaque UUID rather than the row id so
 * nobody can opt someone else out by editing the URL.
 */
import express, { Router } from "express";
import { unsubscribeByToken } from "../agents/ember/store";

export function createEmberRouter(): Router {
  const router = express.Router();

  router.get("/unsubscribe/:token", async (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // A null (unknown token) shows the same page as a real match — never
    // reveal token validity to an anonymous requester. Only a thrown error
    // is a failure.
    try {
      await unsubscribeByToken(req.params.token);
    } catch (error) {
      console.error("[EMB] unsubscribe failed:", error);
      res.status(500).send("<p>Something went wrong. Please try again later.</p>");
      return;
    }
    res.send("<p>You have been unsubscribed and will not receive further messages.</p>");
  });

  return router;
}
