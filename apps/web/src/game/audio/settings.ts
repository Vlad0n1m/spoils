/**
 * Audio settings: a tiny store persisted in localStorage (key `extract.audio.v1`).
 *
 * This is a per-viewer convenience, so every storage access is wrapped in try/catch: private
 * windows, blocked site data or SSR must never break audio — they just fall back to defaults.
 * The AudioEngine subscribes to this store; React reads it with `useAudioSettings()`.
 */
import { useCallback, useSyncExternalStore } from "react";

export interface AudioSettings {
  /** 0..1 slider values (mapped to gain by `volumeToGain`). */
  master: number;
  sfx: number;
  ambience: number;
  ui: number;
  muted: boolean;
  /** "Visualize sound effects" ring (mobility memo); stored here so the audio popover has one key. */
  visualize: boolean;
  /** Photosensitivity: cap the lightning flash at a faint tint (weather-fx FLASH_REDUCED_MAX). */
  reduceFlashes: boolean;
}

export const STORAGE_KEY = "extract.audio.v1";

export const DEFAULT_SETTINGS: Readonly<AudioSettings> = Object.freeze({
  master: 0.8,
  sfx: 1,
  ambience: 0.7,
  ui: 0.8,
  muted: false,
  visualize: true,
  reduceFlashes: false,
});

const unit = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

/** Accepts anything (corrupt JSON, older shapes) and returns a valid settings object. */
export function sanitizeSettings(raw: unknown): AudioSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  return {
    master: unit(o.master, d.master),
    sfx: unit(o.sfx, d.sfx),
    ambience: unit(o.ambience, d.ambience),
    ui: unit(o.ui, d.ui),
    muted: bool(o.muted, d.muted),
    visualize: bool(o.visualize, d.visualize),
    reduceFlashes: bool(o.reduceFlashes, d.reduceFlashes),
  };
}

/**
 * Slider → gain. A squared curve is close to perceived loudness (half the slider ≈ -12 dB) and,
 * unlike a dB scale, reaches true silence at 0.
 */
export function volumeToGain(v: number): number {
  const x = unit(v, 0);
  return x * x;
}

/** Minimal Storage surface, so tests can pass a fake. */
export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function defaultStorage(): KV | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // Accessing localStorage itself throws when site data is blocked.
    return null;
  }
}

export function loadSettings(storage: KV | null = defaultStorage()): AudioSettings {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AudioSettings, storage: KV | null = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(s));
    return true;
  } catch {
    // Quota or blocked storage: the setting still applies for this session.
    return false;
  }
}

// ---------------------------------------------------------------- store

type Listener = (s: AudioSettings) => void;
let current: AudioSettings | null = null;
const listeners = new Set<Listener>();

export function getSettings(): AudioSettings {
  if (!current) current = loadSettings();
  return current;
}

/** Merge a patch, persist, notify. Returns the new settings. */
export function updateSettings(patch: Partial<AudioSettings>): AudioSettings {
  const next = sanitizeSettings({ ...getSettings(), ...patch });
  current = next;
  saveSettings(next);
  for (const l of listeners) l(next);
  return next;
}

export function toggleMute(): AudioSettings {
  return updateSettings({ muted: !getSettings().muted });
}

export function subscribeSettings(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Test hook: forget the cached settings (next read hits storage again). */
export function resetSettingsCache(): void {
  current = null;
}

const getServerSnapshot = () => DEFAULT_SETTINGS as AudioSettings;

/** React binding: `[settings, update]`. SSR renders defaults; the client hydrates from storage. */
export function useAudioSettings(): [AudioSettings, (patch: Partial<AudioSettings>) => void] {
  const s = useSyncExternalStore(subscribeSettings, getSettings, getServerSnapshot);
  const update = useCallback((patch: Partial<AudioSettings>) => {
    updateSettings(patch);
  }, []);
  return [s, update];
}
