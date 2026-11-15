"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  collectTranscripts,
  describeSpeechRecognitionError,
  resolveSpeechRecognitionConstructor,
  type SpeechRecognitionLike,
} from "@/lib/voiceInput";

interface UseVoiceInputOptions {
  /** Called with each finalized chunk of dictated text. */
  onTranscript: (transcript: string) => void;
  lang?: string;
}

interface UseVoiceInputReturn {
  supported: boolean;
  listening: boolean;
  interimText: string;
  error: string | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

export function useVoiceInput({ onTranscript, lang }: UseVoiceInputOptions): UseVoiceInputReturn {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    // Detected after mount so server and client markup match.
    setSupported(resolveSpeechRecognitionConstructor(window) !== null);
    return () => {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        try {
          recognition.abort();
        } catch {
          // Already stopped.
        }
      }
    };
  }, []);

  const stop = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // Already stopped.
    }
  }, []);

  const start = useCallback(() => {
    if (recognitionRef.current) return;
    const Recognition = resolveSpeechRecognitionConstructor(window);
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang ?? (navigator.language || "en-US");
    recognition.onresult = (event) => {
      const { finalText, interimText: nextInterim } = collectTranscripts(event);
      if (finalText.trim()) {
        onTranscriptRef.current(finalText);
      }
      setInterimText(nextInterim.trim());
    };
    recognition.onerror = (event) => {
      setError(describeSpeechRecognitionError(event.error));
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
      setListening(false);
      setInterimText("");
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setError(null);
      setListening(true);
    } catch {
      recognitionRef.current = null;
      setListening(false);
      setError("Voice input could not start.");
    }
  }, [lang]);

  const toggle = useCallback(() => {
    if (recognitionRef.current) {
      stop();
    } else {
      start();
    }
  }, [start, stop]);

  return { supported, listening, interimText, error, start, stop, toggle };
}
