/**
 * Haptics (phones, the Android app): short vibration patterns for the moments a player should feel
 * through the screen — taking damage, a landed hit, a kill, a pickup, the extraction, low HP and the
 * wipe warning. Only on touch devices (coarse pointer, touch-mode.ts) whose browser has
 * navigator.vibrate; desktop and iOS Safari (no Vibration API) stay silent.
 *
 * The toggle ("Vibration" in the audio popover, default on) is a per-device convenience in
 * localStorage `extract.haptics.v1`, every access wrapped in try/catch like audio/settings.ts.
 *
 * Throttling (HapticGate, pure and tested in haptics.test.ts): each kind has a minimum gap, so an SMG
 * landing ten hits a second buzzes about three times, and a pattern never cuts into a stronger one
 * that is still playing (a light hit tick cannot cancel the kill pattern). A stronger pattern
 * replaces a weaker one (navigator.vibrate cancels whatever runs).
 *
 * Kept free of Pixi so the React settings popover can import it; the in-raid wiring is
 * haptics-system.ts.
 */
import { useCallback, useSyncExternalStore } from "react";
import { shouldUseTouch } from "./touch-mode";

export type HapticKind = "hit" | "damage" | "kill" | "loot" | "extract" | "lowHp" | "wipe";

export interface HapticDef {
  /** navigator.vibrate pattern: on, off, on … in ms. */
  pattern: readonly number[];
  /** Minimum gap between two patterns of this kind, ms. */
  minGapMs: number;
  /** A pattern never interrupts a stronger one that is still playing. */
  priority: number;
}

/**
 * Short and distinct: a tick for a hit, a thud for damage, a double knock for a kill, a soft double
 * tap for loot, a long rising triple for the extraction, a heartbeat for low HP, two long pulses for
 * the wipe warning. Every pattern stays under half a second except the two rare ones.
 */
export const HAPTICS: Readonly<Record<HapticKind, HapticDef>> = Object.freeze({
  hit: { pattern: [12], minGapMs: 300, priority: 1 },
  loot: { pattern: [15, 60, 15], minGapMs: 400, priority: 2 },
  damage: { pattern: [45], minGapMs: 350, priority: 3 },
  lowHp: { pattern: [60, 110, 40], minGapMs: 6_000, priority: 4 },
  kill: { pattern: [30, 50, 70], minGapMs: 400, priority: 5 },
  wipe: { pattern: [180, 120, 180], minGapMs: 5_000, priority: 5 },
  extract: { pattern: [40, 60, 40, 60, 140], minGapMs: 2_000, priority: 6 },
});

/** Total length of a pattern (on + off), ms. */
export function patternMs(p: readonly number[]): number {
  let t = 0;
  for (const x of p) t += x > 0 ? x : 0;
  return t;
}

/**
 * The throttle: per-kind gaps and the priority rule. Pure (time is passed in), so tests drive it
 * with a fake clock; `fire` answers whether the pattern should play now and records it if so.
 */
export class HapticGate {
  private readonly last = new Map<HapticKind, number>();
  private busyUntil = Number.NEGATIVE_INFINITY;
  private busyPriority = 0;

  constructor(private readonly defs: Readonly<Record<HapticKind, HapticDef>> = HAPTICS) {}

  fire(kind: HapticKind, nowMs: number): boolean {
    const def = this.defs[kind];
    const prev = this.last.get(kind);
    if (prev !== undefined && nowMs - prev < def.minGapMs) return false;
    if (nowMs < this.busyUntil && def.priority < this.busyPriority) return false;
    this.last.set(kind, nowMs);
    this.busyUntil = nowMs + patternMs(def.pattern);
    this.busyPriority = def.priority;
    return true;
  }

  reset(): void {
    this.last.clear();
    this.busyUntil = Number.NEGATIVE_INFINITY;
    this.busyPriority = 0;
  }
}

// ---------------------------------------------------------------- setting

export const HAPTICS_STORAGE_KEY = "extract.haptics.v1";

/** Minimal Storage surface, so tests can pass a fake. */
export interface HapticsKV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function defaultStorage(): HapticsKV | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Stored "0" turns vibration off; anything else (nothing stored, junk) is the default: on. */
export function loadHapticsEnabled(storage: HapticsKV | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(HAPTICS_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveHapticsEnabled(on: boolean, storage: HapticsKV | null = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(HAPTICS_STORAGE_KEY, on ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}

let enabled: boolean | null = null;
const listeners = new Set<() => void>();

export function hapticsEnabled(): boolean {
  if (enabled === null) enabled = loadHapticsEnabled();
  return enabled;
}

export function setHapticsEnabled(on: boolean): void {
  enabled = on;
  saveHapticsEnabled(on);
  if (!on) stopVibration();
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// ---------------------------------------------------------------- device

type VibrateFn = (pattern: number | number[]) => boolean;

function vibrateFn(): VibrateFn | null {
  if (typeof navigator === "undefined") return null;
  const v = (navigator as Navigator & { vibrate?: unknown }).vibrate;
  return typeof v === "function" ? (v as VibrateFn).bind(navigator) : null;
}

/** A touch device whose browser can vibrate: the only place the toggle shows and patterns play. */
export function hapticsSupported(): boolean {
  try {
    return vibrateFn() !== null && shouldUseTouch();
  } catch {
    return false;
  }
}

function stopVibration(): void {
  try {
    vibrateFn()?.(0);
  } catch {
    // ignore
  }
}

const gate = new HapticGate();

/**
 * Plays `kind` if the device supports it, the player left vibration on and the throttle allows it.
 * Never throws (some WebViews throw without the VIBRATE permission). Returns whether it buzzed.
 */
export function haptic(kind: HapticKind, nowMs: number = typeof performance !== "undefined" ? performance.now() : Date.now()): boolean {
  if (!hapticsEnabled() || !hapticsSupported()) return false;
  if (!gate.fire(kind, nowMs)) return false;
  try {
    return vibrateFn()?.([...HAPTICS[kind].pattern]) ?? false;
  } catch {
    return false;
  }
}

/** Raid over or left: forget the gaps so the next raid starts fresh. */
export function resetHaptics(): void {
  gate.reset();
}

// ---------------------------------------------------------------- React

const serverFalse = () => false;
const serverTrue = () => true;
const noSubscribe = () => () => {};

/** `[supported, enabled, setEnabled]` for the settings popover. SSR: unsupported, on. */
export function useHaptics(): [boolean, boolean, (on: boolean) => void] {
  const supported = useSyncExternalStore(noSubscribe, hapticsSupported, serverFalse);
  const on = useSyncExternalStore(subscribe, hapticsEnabled, serverTrue);
  const set = useCallback((v: boolean) => setHapticsEnabled(v), []);
  return [supported, on, set];
}
