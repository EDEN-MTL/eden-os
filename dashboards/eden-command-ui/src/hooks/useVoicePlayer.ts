import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Plays a speech audio blob and exposes a live 0-1 amplitude level while it
 * plays, sampled from the actual audio via Web Audio's AnalyserNode — this
 * is what lets the reactor orb move with the real voice, not a fake pulse.
 */
export function useVoicePlayer() {
  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const resolveRef = useRef<(() => void) | null>(null);

  const stopMeter = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setLevel(0);
  }, []);

  const play = useCallback(
    async (blob: Blob) => {
      if (!audioElRef.current) {
        audioElRef.current = new Audio();
      }
      const audioEl = audioElRef.current;

      if (!audioCtxRef.current) {
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        audioCtxRef.current = new Ctx();
        sourceRef.current = audioCtxRef.current.createMediaElementSource(audioEl);
        analyserRef.current = audioCtxRef.current.createAnalyser();
        analyserRef.current.fftSize = 256;
        sourceRef.current.connect(analyserRef.current);
        analyserRef.current.connect(audioCtxRef.current.destination);
      }
      if (audioCtxRef.current.state === "suspended") {
        await audioCtxRef.current.resume();
      }

      const url = URL.createObjectURL(blob);
      audioEl.src = url;

      const data = new Uint8Array(analyserRef.current!.frequencyBinCount);
      const tick = () => {
        analyserRef.current!.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setLevel(Math.min(1, avg / 130));
        rafRef.current = requestAnimationFrame(tick);
      };

      setSpeaking(true);
      tick();

      await new Promise<void>((resolve) => {
        // Held so stop() can settle this promise. Without it, interrupting
        // playback leaves whoever awaited play() hanging forever, and the
        // auto-listen that runs after EDEN finishes never fires again.
        resolveRef.current = resolve;
        audioEl.onended = () => resolve();
        audioEl.onerror = () => resolve();
        audioEl.play().catch(() => resolve());
      });

      resolveRef.current = null;
      setSpeaking(false);
      stopMeter();
      URL.revokeObjectURL(url);
    },
    [stopMeter]
  );

  /**
   * Cut EDEN off mid-sentence.
   *
   * Pauses and rewinds the element rather than tearing down the AudioContext:
   * the context, analyser and source node are created once and reused, so
   * destroying them would break every later play() — and creating a second
   * MediaElementAudioSourceNode for the same element throws.
   */
  const stop = useCallback(() => {
    const el = audioElRef.current;
    if (el) {
      el.pause();
      try { el.currentTime = 0; } catch { /* not seekable yet */ }
    }
    resolveRef.current?.();
    resolveRef.current = null;
    setSpeaking(false);
    stopMeter();
  }, [stopMeter]);

  useEffect(() => stopMeter, [stopMeter]);

  return { play, stop, level, speaking };
}
