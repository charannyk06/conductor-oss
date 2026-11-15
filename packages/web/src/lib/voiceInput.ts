/** Pure helpers for Web Speech API dictation in the dispatcher composer. */

export interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike | undefined;
}

export interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike | undefined;
}

export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/** Finds the (possibly vendor-prefixed) SpeechRecognition constructor on a window-like object. */
export function resolveSpeechRecognitionConstructor(scope: unknown): SpeechRecognitionConstructor | null {
  if (!scope || typeof scope !== "object") return null;
  const candidates = scope as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  const constructor = candidates.SpeechRecognition ?? candidates.webkitSpeechRecognition;
  return typeof constructor === "function" ? (constructor as SpeechRecognitionConstructor) : null;
}

/** Collects the final and interim transcripts reported by one recognition event. */
export function collectTranscripts(event: SpeechRecognitionEventLike): { finalText: string; interimText: string } {
  let finalText = "";
  let interimText = "";
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    const transcript = result?.[0]?.transcript ?? "";
    if (!transcript) continue;
    if (result?.isFinal) {
      finalText += transcript;
    } else {
      interimText += transcript;
    }
  }
  return { finalText, interimText };
}

/** Appends dictated text to a draft with sensible spacing; never drops existing text. */
export function appendTranscript(draft: string, transcript: string): string {
  const addition = transcript.replace(/\s+/g, " ").trim();
  if (!addition) return draft;
  if (!draft.trim()) return addition;
  const separator = /\s$/.test(draft) ? "" : " ";
  return `${draft}${separator}${addition}`;
}

export function describeSpeechRecognitionError(code: string | null | undefined): string | null {
  switch (code) {
    case null:
    case undefined:
    case "":
    case "aborted":
    case "no-speech":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was blocked. Allow it in your browser settings to dictate.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Voice input needs a network connection in this browser.";
    default:
      return "Voice input stopped unexpectedly.";
  }
}
