"use client";

import { useEffect } from "react";
import { keepLandscape, lockLandscape } from "@/game/orientation";
import { reloadOnChunkError } from "@/lib/chunk-reload";
import { RotateOverlay, usePortrait } from "./rotate-overlay";
import { useTouchMode } from "./use-touch-mode";

/**
 * App-wide landscape on phones (lobby, menus and raid alike): asks for the landscape lock, and on the
 * first tap of a browser tab (not the installed app) goes fullscreen, where Android Chrome honours the
 * lock. A phone held upright anyway gets the "rotate your phone" cover over everything. Also reloads
 * once when a lazy chunk from a previous deploy is gone.
 */
export function LandscapeGuard() {
  const touch = useTouchMode();
  const portrait = usePortrait();

  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      if (reloadOnChunkError(e.reason)) e.preventDefault();
    };
    const onError = (e: ErrorEvent) => {
      reloadOnChunkError(e.error ?? e.message);
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);

  useEffect(() => {
    if (!touch) return;
    const stop = keepLandscape();
    const standalone = window.matchMedia?.("(display-mode: fullscreen), (display-mode: standalone)").matches ?? false;
    if (standalone) return stop;
    const goFullscreen = () => {
      const el = document.documentElement as HTMLElement & { requestFullscreen?: (o?: FullscreenOptions) => Promise<void> };
      if (document.fullscreenElement || typeof el.requestFullscreen !== "function") return;
      el.requestFullscreen({ navigationUI: "hide" }).then(lockLandscape).catch(() => {});
    };
    window.addEventListener("pointerup", goFullscreen, { once: true });
    return () => {
      stop();
      window.removeEventListener("pointerup", goFullscreen);
    };
  }, [touch]);

  return touch && portrait ? <RotateOverlay fixed /> : null;
}
