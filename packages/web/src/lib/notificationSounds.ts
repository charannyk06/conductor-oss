"use client";

export type NotificationSoundId =
  | "abstract-sound-1"
  | "abstract-sound-2"
  | "abstract-sound-3"
  | "abstract-sound-4"
  | "cow-mooing"
  | "phone-vibration"
  | "rooster";

type ToneStep = {
  frequency: number;
  durationMs: number;
  gain?: number;
  type?: OscillatorType;
};

type NotificationSoundPattern = {
  vibrate?: number[];
  steps?: ToneStep[];
};

const DEFAULT_SOUND_ID: NotificationSoundId = "abstract-sound-4";

const SOUND_PATTERNS: Record<NotificationSoundId, NotificationSoundPattern> = {
  "abstract-sound-1": {
    steps: [
      { frequency: 784, durationMs: 90, gain: 0.24 },
      { frequency: 988, durationMs: 90, gain: 0.22 },
      { frequency: 1175, durationMs: 120, gain: 0.2 },
    ],
  },
  "abstract-sound-2": {
    steps: [
      { frequency: 659, durationMs: 120, gain: 0.22 },
      { frequency: 523, durationMs: 140, gain: 0.2 },
      { frequency: 659, durationMs: 120, gain: 0.18 },
    ],
  },
  "abstract-sound-3": {
    steps: [
      { frequency: 440, durationMs: 80, gain: 0.22 },
      { frequency: 554, durationMs: 80, gain: 0.22 },
      { frequency: 659, durationMs: 90, gain: 0.2 },
      { frequency: 880, durationMs: 120, gain: 0.18 },
    ],
  },
  "abstract-sound-4": {
    steps: [
      { frequency: 523, durationMs: 130, gain: 0.22 },
      { frequency: 659, durationMs: 130, gain: 0.2 },
      { frequency: 784, durationMs: 150, gain: 0.18 },
    ],
  },
  "cow-mooing": {
    steps: [
      { frequency: 220, durationMs: 220, type: "triangle", gain: 0.24 },
      { frequency: 174, durationMs: 260, type: "triangle", gain: 0.2 },
    ],
  },
  "phone-vibration": {
    vibrate: [120, 60, 120, 60, 180],
    steps: [
      { frequency: 180, durationMs: 140, gain: 0.16 },
      { frequency: 220, durationMs: 140, gain: 0.14 },
    ],
  },
  "rooster": {
    steps: [
      { frequency: 784, durationMs: 70, type: "square", gain: 0.24 },
      { frequency: 1046, durationMs: 70, type: "square", gain: 0.22 },
      { frequency: 1318, durationMs: 90, type: "square", gain: 0.2 },
      { frequency: 1568, durationMs: 120, type: "square", gain: 0.18 },
    ],
  },
};

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }

  type BrowserWindowWithAudio = Window & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const browserWindow = window as BrowserWindowWithAudio;
  const AudioContextClass = browserWindow.AudioContext ?? browserWindow.webkitAudioContext;
  if (!AudioContextClass) {
    return null;
  }

  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContextClass();
  }

  return sharedAudioContext;
}

function normalizeSoundId(value: string | null | undefined): NotificationSoundId {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_SOUND_ID;
  return trimmed in SOUND_PATTERNS ? (trimmed as NotificationSoundId) : DEFAULT_SOUND_ID;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hasVibrationSupport(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

function scheduleToneStep(
  context: AudioContext,
  at: number,
  step: ToneStep,
  volume: number,
) {
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const peakGain = clamp((step.gain ?? 1) * volume, 0.02, 0.9);
  const durationSeconds = Math.max(0.04, step.durationMs / 1000);
  const rampEnd = at + Math.max(0.015, Math.min(0.05, durationSeconds * 0.35));
  const fadeStart = at + Math.max(0.02, durationSeconds * 0.7);
  const fadeEnd = at + durationSeconds;

  oscillator.type = step.type ?? "sine";
  oscillator.frequency.setValueAtTime(step.frequency, at);
  gainNode.gain.setValueAtTime(0.0001, at);
  gainNode.gain.linearRampToValueAtTime(peakGain, rampEnd);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, fadeStart);
  gainNode.gain.setValueAtTime(0.0001, fadeEnd);

  oscillator.connect(gainNode);
  gainNode.connect(context.destination);
  oscillator.start(at);
  oscillator.stop(fadeEnd + 0.05);
}

export function getNotificationSoundList(): NotificationSoundId[] {
  return Object.keys(SOUND_PATTERNS) as NotificationSoundId[];
}

export function resolveNotificationSoundId(value: string | null | undefined): NotificationSoundId {
  return normalizeSoundId(value);
}

export async function primeNotificationAudio(): Promise<boolean> {
  const context = getAudioContext();
  if (!context) {
    return false;
  }

  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch {
      return false;
    }
  }

  return context.state === "running";
}

export async function playNotificationSound(
  soundId: string | null | undefined,
  options?: { volume?: number },
): Promise<boolean> {
  const normalizedSoundId = normalizeSoundId(soundId);
  const pattern = SOUND_PATTERNS[normalizedSoundId];

  if (normalizedSoundId === "phone-vibration" && pattern.vibrate && hasVibrationSupport()) {
    return navigator.vibrate(pattern.vibrate);
  }

  const context = getAudioContext();
  if (!context || !pattern.steps || pattern.steps.length === 0) {
    return false;
  }

  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch {
      return false;
    }
  }

  if (context.state !== "running") {
    return false;
  }

  const volume = clamp(options?.volume ?? 0.4, 0.05, 0.8);
  const startAt = context.currentTime + 0.02;
  let currentAt = startAt;

  for (const step of pattern.steps) {
    scheduleToneStep(context, currentAt, step, volume);
    currentAt += Math.max(0.06, step.durationMs / 1000 + 0.04);
  }

  return true;
}
