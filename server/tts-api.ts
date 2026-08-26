import { Request, Response, Router } from "express";

import { speakable } from "../shared/tts/speakable";

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

/*
 * Voice settings, tuned for conversation rather than narration.
 *
 * stability low-ish: higher values flatten delivery into a newsreader. Lower
 *   gives more variation in pace and emphasis, which is what makes it sound
 *   like talking. Too low and it becomes unstable between sentences.
 * style: a little expressiveness. Above ~0.5 it starts over-acting.
 * speed: EDEN's replies are dense, and at 1.0 they drag. 1.12 is noticeably
 *   quicker without clipping consonants.
 *
 * These are the knobs worth touching if the delivery still feels wrong;
 * everything else is better fixed in the text itself.
 */
const VOICE_SETTINGS = {
  stability: 0.42,
  similarity_boost: 0.8,
  style: 0.32,
  use_speaker_boost: true,
  speed: 1.12,
};

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

    const speech = speakable(text);
    if (!speech) {
      // The reply was only a code block, a table or symbols. Nothing to say.
      return res.status(204).end();
    }

    try {
      const response = await fetch(`${ELEVENLABS_TTS_URL}/${voiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Sanitised first: raw markdown is read out as symbol names and
          // paragraph breaks become multi-second gaps. Truncate AFTER
          // stripping, so the 2000 characters are all speech.
          text: speech.slice(0, 2000),
          model_id: "eleven_turbo_v2_5",
          voice_settings: VOICE_SETTINGS,
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
