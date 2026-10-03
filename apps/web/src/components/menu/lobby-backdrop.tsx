import { ZooaAmbientBg } from "@/components/zooa-ambient-bg";

/**
 * Full-screen menu backdrop (WORLD v6 spec §6.6): the lobby art `public/lobby/bg.webp` (step S10)
 * with dark side and bottom vignettes so the side buttons and PLAY read on top. Until the art
 * exists the fallback layers below it show through: the ambient glow plus the grass tile. Pure CSS
 * layers, no JS and no canvas.
 */
export function LobbyBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div className="absolute inset-0 bg-[#090b08]" />
      <div className="absolute inset-0 bg-[url('/sprites/grass_tile.png')] bg-[length:256px_256px] opacity-[0.18]" />
      <ZooaAmbientBg />
      <div className="absolute inset-0 bg-[url('/lobby/bg.webp')] bg-cover bg-center" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,#090b08cc_0,transparent_22%,transparent_78%,#090b08cc_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(0deg,#090b08_0,transparent_35%)]" />
    </div>
  );
}
