import clsx from "clsx";
import { FallbackImg } from "./fallback-img";

/** Armour level of a loadout for the hero art: armor_1..3 → 1..3, none → 0. */
export function armorLevelOf(entries: ReadonlyArray<{ key: string; def: string }>): 0 | 1 | 2 | 3 {
  const a = entries.find((e) => e.key === "armor")?.def ?? "";
  const m = /^armor_([123])$/.exec(a);
  return m ? (Number(m[1]) as 1 | 2 | 3) : 0;
}

/**
 * Centre hero (WORLD v6 spec §6.6): `public/lobby/hero_{0..3}.png` by armour (step S10), standing on
 * the glowing extract ring and breathing slowly. Fallback until the art exists: the top-down
 * player sprite turned −12°, as on the landing page. Hidden on short screens (< 640 px tall) so
 * PLAY always fits.
 */
export function HeroStage({ armor, className }: { armor: 0 | 1 | 2 | 3; className?: string }) {
  return (
    <div className={clsx("relative mx-auto flex h-full min-h-0 w-full max-w-md items-end justify-center [@media(max-height:640px)]:hidden", className)} aria-hidden>
      {/* Extract ring under the feet: squashed for perspective. */}
      <div className="absolute bottom-[4%] left-1/2 h-40 w-72 [transform:translateX(-50%)_scaleY(0.35)] md:h-56 md:w-96">
        <div className="absolute -inset-6 rounded-full bg-zooa-lime/30 blur-2xl animate-soft-glow motion-reduce:animate-none" />
        <div className="relative h-full w-full rounded-full border-[6px] border-dashed border-zooa-lime/80 bg-zooa-lime/10" />
      </div>
      <div className="relative flex h-full max-h-[46vh] w-full items-end justify-center pb-[6%] animate-hero-idle motion-reduce:animate-none">
        <FallbackImg
          key={armor}
          src={`/lobby/hero_${armor}.png`}
          fallback="/sprites/player.png"
          className="h-full max-h-full w-auto object-contain drop-shadow-[0_10px_0_rgba(0,0,0,0.35)]"
          fallbackClassName="!h-[60%] -rotate-12 [filter:drop-shadow(0_6px_0_#000)]"
        />
      </div>
    </div>
  );
}
