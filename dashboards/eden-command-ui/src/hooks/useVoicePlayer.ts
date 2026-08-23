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
        audioEl.onended = () => resolve();
        audioEl.onerror = () => resolve();
        audioEl.play().catch(() => resolve());
      });

      setSpeaking(false);
      stopMeter();
      URL.revokeObjectURL(url);
    },
    [stopMeter]
  );

  useEffect(() => stopMeter, [stopMeter]);

  return { play, level, speaking };
}
