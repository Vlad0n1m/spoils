"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { FallbackImg } from "./fallback-img";

/** Lobby background art of step S10 (LobbyBackdrop); it has the extract ring painted on its pad. */
const BG_ART = "/lobby/bg.webp";

/** True once `src` has loaded in this page (the browser cache makes the second request free). */
function useArtLoaded(src: string): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    const img = new Image();
    img.onload = () => live && setOk(true);
    img.onerror = () => live && setOk(false);
    img.src = src;
    if (img.complete && img.naturalWidth > 0) setOk(true);
    return () => {
      live = false;
    };
  }, [src]);
  return ok;
}

/** Armour level of a loadout for the hero art: armor_1..3 → 1..3, none → 0. */
export function armorLevelOf(entries: ReadonlyArray<{ key: string; def: string }>): 0 | 1 | 2 | 3 {
  const a = entries.find((e) => e.key === "armor")?.def ?? "";
  const m = /^armor_([123])$/.exec(a);
  return m ? (Number(m[1]) as 1 | 2 | 3) : 0;
}

/**
 * Where the background art's painted extract ring lands on screen. LobbyBackdrop draws bg.webp
 * (1536×1024) with `background-size: cover` centred, so the image is scaled by
 * max(100vw / 1536, 100dvh / 1024); the ring's centre sits at (48.6 %, 65.2 %) of the image.
 */
export const RING_X = "calc(50vw - 0.014 * max(100vw, 150dvh))";
export const RING_Y = "calc(50dvh + 0.152 * max(100dvh, 66.667vw))";

/** RING_X in px for a viewport (the same formula in JS). */
export function ringXPx(vw: number, vh: number): number {
  return vw / 2 - 0.014 * Math.max(vw, 1.5 * vh);
}

/**
 * Slides `el` sideways (translateX) so its centre sits under the hero (RING_X) as far as its parent
 * column allows; re-measured on resize. The gear plate uses it: the hero stands on the art's ring,
 * which is not the middle of the centre column.
 */
export function useUnderHero(el: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = el.current;
    const parent = node?.parentElement;
    if (!node || !parent) return;
    const place = () => {
      const p = parent.getBoundingClientRect();
      const w = node.offsetWidth;
      const room = Math.max(0, (p.width - w) / 2);
      const want = ringXPx(window.innerWidth, window.innerHeight) - (p.left + p.width / 2);
      node.style.transform = `translateX(${Math.round(Math.max(-room, Math.min(room, want)))}px)`;
    };
    place();
    window.addEventListener("resize", place);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    ro?.observe(node);
    ro?.observe(parent);
    return () => {
      window.removeEventListener("resize", place);
      ro?.disconnect();
    };
  }, [el]);
}

/**
 * Centre hero (Brawl Stars layout): `public/lobby/hero_{0..3}.png` by armour (step S10), standing in
 * the middle of the ring painted on the background art (RING_X / RING_Y follow the art's cover
 * scaling), as tall as the space between the top bar (or, on portrait phones, the world card) and
 * the ring allows, on a lime glow and breathing slowly. Without the background art a CSS dashed ring
 * is drawn at the same spot. Fallback until the hero art exists: the top-down player sprite turned
 * −12°, as on the landing page. Decorative: the menu draws it under its controls.
 */
export function HeroStage({ armor, className }: { armor: 0 | 1 | 2 | 3; className?: string }) {
  const bgArt = useArtLoaded(BG_ART);
  return (
    <div
      className={clsx(
        "pointer-events-none absolute inset-0 [--hero-top:5rem] port:[--hero-top:16rem] short:[--hero-top:3.9rem]",
        className,
      )}
      aria-hidden
    >
      {/* Glow (and, without the background art, the extract ring) under the feet: squashed for perspective. */}
      <div
        className="absolute h-[min(30vw,22rem)] w-[min(30vw,22rem)] [transform:translate(-50%,-50%)_scaleY(0.38)]"
        style={{ left: RING_X, top: RING_Y }}
      >
        <div className="absolute inset-[12%] rounded-full bg-zooa-lime/35 blur-2xl animate-soft-glow motion-reduce:animate-none" />
        {!bgArt && <div className="relative h-full w-full rounded-full border-[6px] border-dashed border-zooa-lime/80 bg-zooa-lime/10" />}
      </div>
      <div
        className="absolute flex -translate-x-1/2 -translate-y-full items-end justify-center"
        style={{ left: RING_X, top: `calc(${RING_Y} + 1.5%)`, height: `calc(${RING_Y} + 1.5% - var(--hero-top))` }}
      >
        <div className="flex h-full items-end animate-hero-idle motion-reduce:animate-none">
          <FallbackImg
            key={armor}
            src={`/lobby/hero_${armor}.png`}
            fallback="/sprites/player.png"
            className="h-full max-h-full w-auto object-contain drop-shadow-[0_8px_0_rgba(0,0,0,0.4)]"
            fallbackClassName="!h-[60%] -rotate-12 [filter:drop-shadow(0_6px_0_#000)]"
          />
        </div>
      </div>
    </div>
  );
}
