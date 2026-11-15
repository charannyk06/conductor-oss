"use client";

import { Mic, Square } from "lucide-react";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { cn } from "@/lib/cn";

type ComposerVoiceButtonProps = {
  disabled?: boolean;
  /** Receives each finalized chunk of dictated text. */
  onTranscript: (transcript: string) => void;
};

/**
 * Dictation toggle for the dispatcher composer. Renders nothing in browsers
 * without the Web Speech API.
 */
export function ComposerVoiceButton({ disabled = false, onTranscript }: ComposerVoiceButtonProps) {
  const { supported, listening, interimText, error, toggle } = useVoiceInput({ onTranscript });

  if (!supported) {
    return null;
  }

  const hint = listening ? (interimText || "Listening…") : error;

  return (
    <div className="relative shrink-0">
      {hint ? (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "pointer-events-none absolute bottom-full right-0 mb-2 w-max max-w-[min(70vw,320px)] truncate rounded-full border px-3 py-1 text-[11px]",
            listening
              ? "border-[rgba(255,255,255,0.08)] bg-[#1c1917] text-[var(--vk-text-normal)]"
              : "border-[rgba(210,81,81,0.35)] bg-[#1c1917] text-[#ffd7d7]",
          )}
        >
          {hint}
        </div>
      ) : null}
      <button
        type="button"
        onClick={toggle}
        disabled={disabled && !listening}
        aria-pressed={listening}
        aria-label={listening ? "Stop voice input" : "Start voice input"}
        title={listening ? "Stop voice input" : "Dictate a message"}
        className={cn(
          "inline-flex h-10 w-10 items-center justify-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-60",
          listening
            ? "border-[var(--vk-red)]/50 bg-[color:color-mix(in_srgb,var(--vk-red)_22%,transparent)] text-[var(--vk-red)]"
            : "border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[var(--vk-text-normal)] hover:bg-[rgba(255,255,255,0.08)]",
        )}
      >
        {listening ? <Square className="h-3.5 w-3.5 fill-current" /> : <Mic className="h-4 w-4" />}
      </button>
    </div>
  );
}
