import { Request, Response, Router } from "express";

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

/**
 * HTTP proxy for ElevenLabs text-to-speech — keeps the API key server-side.
 * The dashboard posts { text } and gets back an audio/mpeg stream.
 */
export function createTtsRouter(): Router {
  const router = Router();

  router.use((req: Request, res: Response, next) => {
    const allowedOrigin = process.env.DASHBOARD_ORIGIN || "*";
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-dashboard-key");
    if (req.method === "OPTIONS") return res.status(204).send();
    next();
  });

  router.use((req: Request, res: Response, next) => {
    const requiredKey = process.env.DASHBOARD_API_KEY;
    if (!requiredKey) return next();
    if (req.headers["x-dashboard-key"] !== requiredKey) {
      return res.status(401).json({ error: "Invalid or missing dashboard key" });
    }
    next();
  });

  router.post("/", async (req: Request, res: Response) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    const { text } = req.body;

    if (!apiKey || !voiceId) {
      return res.status(501).json({ error: "TTS not configured" });
    }
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing 'text' string in body" });
    }

    try {
      const response = await fetch(`${ELEVENLABS_TTS_URL}/${voiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: text.slice(0, 2000),
          model_id: "eleven_turbo_v2_5",
        }),
      });

      if (!response.ok || !response.body) {
        const errorText = await response.text();
        console.error("[TTS] ElevenLabs error:", response.status, errorText);
        return res.status(502).json({ error: "TTS synthesis failed" });
      }

      res.setHeader("Content-Type", "audio/mpeg");
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (error) {
      console.error("[TTS] Error:", error);
      res.status(502).json({ error: "TTS synthesis failed" });
    }
  });

  return router;
}
