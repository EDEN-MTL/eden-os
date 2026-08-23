import { useCallback, useEffect, useRef, useState } from "react";

type SpeechRecognitionCtor = new () => any;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

export const SPEECH_RECOGNITION_SUPPORTED = !!getRecognitionCtor();

/**
 * Click-to-talk mic input via the browser's built-in speech recognition.
 * Calls onResult with the final transcript once the user stops talking.
 */
export function useSpeechInput(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event: any) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) onResultRef.current(transcript);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);

    recognitionRef.current = recognition;
    return () => recognition.stop();
  }, []);

  const start = useCallback(() => {
    if (!recognitionRef.current || listening) return;
    setListening(true);
    recognitionRef.current.start();
  }, [listening]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  return { start, stop, listening, supported: SPEECH_RECOGNITION_SUPPORTED };
}
