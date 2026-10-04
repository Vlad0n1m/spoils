"use client";

/**
 * Audio settings popover (WP-A1): master / sfx / ambience / ui volumes, mute, "visualize sounds"
 * (the sound ring, WP-S) and "reduce flashes" (lightning). Mute lives here only — M is the full
 * map (critique "Key bindings").
 *
 * Everything persists through game/audio/settings.ts (localStorage `extract.audio.v1`, wrapped in
 * try/catch there); the AudioEngine and WeatherFx subscribe to the same store, so a slider drag is
 * heard immediately. Used by the in-raid HUD and the lobby; it is self-contained (no props needed).
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import { useAudioSettings, type AudioSettings } from "../game/audio/settings";
import { useUiSound } from "../game/audio/ui-sounds";

export type VolumeKey = "master" | "sfx" | "ambience" | "ui";
export type ToggleKey = "muted" | "visualize" | "reduceFlashes" | "reduceShake";

export const VOLUME_ROWS: ReadonlyArray<{ key: VolumeKey; label: string }> = [
  { key: "master", label: "Master" },
  { key: "sfx", label: "Effects" },
  { key: "ambience", label: "Ambience" },
  { key: "ui", label: "Interface" },
];

export const TOGGLE_ROWS: ReadonlyArray<{ key: ToggleKey; label: string; hint: string }> = [
  { key: "muted", label: "Mute all", hint: "Silences the game without losing your levels" },
  { key: "visualize", label: "Visualize sounds", hint: "Show footsteps, shots and alarms as a ring around you" },
  { key: "reduceFlashes", label: "Reduce flashes", hint: "Softer lightning for light-sensitive players" },
  { key: "reduceShake", label: "Reduce screen shake", hint: "No camera shake or kill zoom, softer recoil" },
];

/** Slider value 0..1 → whole percent for the label and the range input. */
export function toPercent(v: number): number {
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 100);
}

/** Which speaker glyph to show on the button. */
export function speakerLevel(s: Pick<AudioSettings, "muted" | "master">): "muted" | "low" | "high" {
  if (s.muted || s.master <= 0) return "muted";
  return s.master < 0.5 ? "low" : "high";
}

function SpeakerIcon({ level }: { level: "muted" | "low" | "high" }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
      {level === "muted" ? (
        <path d="M16 9.5l5 5m0-5l-5 5" />
      ) : (
        <>
          <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
          {level === "high" && <path d="M18.5 6.8a7.5 7.5 0 0 1 0 10.4" />}
        </>
      )}
    </svg>
  );
}

export interface AudioSettingsProps {
  className?: string;
  /** Which edge of the button the panel aligns to. */
  align?: "left" | "right";
  /** Open the panel above (HUD bottom corner) or below (top bar) the button. */
  direction?: "up" | "down";
  /** 44 px button (touch HUD) instead of 40 px. */
  large?: boolean;
}

export function AudioSettingsButton({ className, align = "right", direction = "down", large = false }: AudioSettingsProps) {
  const [s, update] = useAudioSettings();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const ui = useUiSound();

  // Close on outside pointer and on Escape (focus goes back to the button for keyboard users).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Arrow keys on a slider must not also walk the character: stop them at the panel.
  const stopGameKeys = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape") e.stopPropagation();
  };

  return (
    <div ref={root} className={clsx("pointer-events-auto relative", className)}>
      <button
        ref={button}
        type="button"
        className={clsx(
          "toon-chip flex items-center justify-center text-white transition-transform hover:brightness-110 active:translate-y-[2px]",
          large ? "h-11 w-11" : "h-10 w-10",
        )}
        aria-label="Audio settings"
        aria-expanded={open}
        aria-controls={panelId}
        title="Audio settings"
        onClick={() => {
          ui.click();
          setOpen((o) => !o);
        }}
      >
        <SpeakerIcon level={speakerLevel(s)} />
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Audio settings"
          onKeyDown={stopGameKeys}
          className={clsx(
            "toon-panel absolute z-50 w-[min(18rem,calc(100vw-2rem))] p-4 text-white",
            align === "right" ? "right-0" : "left-0",
            direction === "down" ? "top-full mt-2" : "bottom-full mb-2",
          )}
        >
          <h2 className="toon-text-thin mb-3 text-lg tracking-wide">Audio</h2>

          <div className={clsx("flex flex-col gap-3", s.muted && "opacity-50")}>
            {VOLUME_ROWS.map((row) => {
              const pct = toPercent(s[row.key]);
              const id = `${panelId}-${row.key}`;
              return (
                <div key={row.key} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-sm">
                    <label htmlFor={id} className="font-body">
                      {row.label}
                    </label>
                    <span className="mono text-xs lg:text-[0.8125rem] tabular-nums text-white/70">{pct}%</span>
                  </div>
                  <input
                    id={id}
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={pct}
                    onChange={(e) => update({ [row.key]: Number(e.currentTarget.value) / 100 } as Partial<AudioSettings>)}
                    className="h-2 w-full cursor-pointer accent-zooa-lime"
                  />
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex flex-col gap-2 border-t-2 border-black/40 pt-3">
            {TOGGLE_ROWS.map((row) => {
              const id = `${panelId}-${row.key}`;
              const on = s[row.key];
              return (
                <label key={row.key} htmlFor={id} className="flex cursor-pointer items-start gap-3 text-sm" title={row.hint}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={on}
                    onChange={(e) => {
                      ui.click();
                      update({ [row.key]: e.currentTarget.checked } as Partial<AudioSettings>);
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-zooa-lime"
                  />
                  <span className="flex flex-col">
                    <span className="font-body">{row.label}</span>
                    <span className="font-body text-xs lg:text-[0.8125rem] text-white/70">{row.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default AudioSettingsButton;
