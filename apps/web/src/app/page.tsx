import Link from "next/link";
import { BREAK_CHANCE_ON_DEATH, MATCH, RARITY_NAMES, WORLD, type WeaponId } from "@extract/shared";
import { Reveal } from "@/components/reveal";
import { BRAND } from "@/lib/brand";
import { rarityHex } from "@/lib/items-ui";

const S = (name: string) => `/sprites/${name}.png`;

function Sprite({
  name,
  className,
  style,
}: {
  name: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static 256px sprites, no optimizer needed
    <img
      src={S(name)}
      alt=""
      draggable={false}
      className={`pointer-events-none select-none object-contain drop-shadow-[0_10px_0_rgba(0,0,0,0.35)] ${className ?? ""}`}
      style={style}
    />
  );
}

function LandingNav() {
  return (
    <header className="absolute left-0 right-0 top-0 z-50 flex min-h-14 items-center justify-between px-4 py-3 md:px-8">
      <Link href="/" className="toon-text-thin text-2xl tracking-wide text-zooa-lime md:text-3xl">
        <span className="optical-center">{BRAND.name}</span>
      </Link>
      <Link href="/play" className="toon-btn min-h-11 text-base tracking-wide">
        <span className="optical-center">Play</span>
      </Link>
    </header>
  );
}

function Marquee() {
  const items = Array.from({ length: 16 }, () => "DROP IN · LOOT UP · GET OUT ALIVE");
  const track = (
    <div className="flex w-max items-center">
      {items.map((t, i) => (
        <span key={i} className="mx-6 text-base tracking-[0.16em] text-black md:text-lg">
          {t}
        </span>
      ))}
    </div>
  );
  return (
    <div className="relative w-full overflow-hidden border-y-[3px] border-black bg-zooa-lime py-3">
      <div className="flex w-max animate-marquee motion-reduce:animate-none">
        {track}
        {track}
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative flex min-h-[100dvh] flex-col overflow-hidden">
      {/* Map grass as the backdrop, darkened toward the edges so the sprites pop. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ backgroundImage: `url(${S("grass_tile")})`, backgroundSize: "256px 256px" }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_75%_65%_at_50%_52%,rgba(10,16,12,0.15)_0%,rgba(10,16,12,0.7)_60%,#0a100c_100%)]"
        aria-hidden
      />

      <LandingNav />

      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 pb-16 pt-24 text-center">
        <Reveal delay={0}>
          <h1
            className="toon-text text-[clamp(4rem,15vw,11rem)] leading-none tracking-wide text-zooa-lime"
            style={{ textShadow: "0 10px 0 #000" }}
          >
            {BRAND.name}
          </h1>
        </Reveal>
        <Reveal as="p" delay={120} className="toon-text-thin mt-4 text-2xl tracking-wide text-white md:text-3xl">
          Drop in. Loot up. Get out alive.
        </Reveal>

        <Reveal delay={220} className="relative mt-6 h-[min(46vh,26rem)] w-full max-w-4xl">
          {/* Extraction circle under the raider */}
          <div
            className="absolute left-1/2 top-1/2 h-[min(36vh,20rem)] w-[min(36vh,20rem)] -translate-x-1/2 -translate-y-1/2 rounded-full border-[6px] border-dashed border-zooa-lime/80 bg-zooa-lime/10 animate-glow-pulse motion-reduce:animate-none"
            aria-hidden
          />
          <Sprite
            name="player"
            className="absolute left-1/2 top-1/2 h-[min(26vh,14rem)] w-[min(26vh,14rem)] -translate-x-1/2 -translate-y-1/2 -rotate-12"
          />
          <Sprite
            name="chest_legendary"
            className="absolute left-[2%] top-[38%] h-28 w-28 animate-float motion-reduce:animate-none md:left-[6%] md:h-40 md:w-40"
          />
          <Sprite
            name="sniper"
            className="absolute right-[0%] top-[8%] h-28 w-40 rotate-[-18deg] animate-float-sm motion-reduce:animate-none md:right-[4%] md:h-36 md:w-56"
            style={{ animationDelay: "600ms" }}
          />
          <Sprite
            name="armor_3"
            className="absolute right-[6%] bottom-[2%] h-24 w-24 animate-float motion-reduce:animate-none md:right-[14%] md:h-32 md:w-32"
            style={{ animationDelay: "1200ms" }}
          />
          <Sprite
            name="shotgun"
            className="absolute left-[12%] top-[0%] hidden h-24 w-36 rotate-12 animate-float-sm motion-reduce:animate-none sm:block md:left-[18%]"
            style={{ animationDelay: "300ms" }}
          />
          <Sprite
            name="medkit"
            className="absolute bottom-[4%] left-[22%] hidden h-16 w-16 animate-float-sm motion-reduce:animate-none sm:block"
            style={{ animationDelay: "900ms" }}
          />
        </Reveal>

        <Reveal delay={340} className="mt-4 flex flex-col items-center gap-4">
          <Link
            href="/play"
            className="toon-btn min-h-20 px-12 text-3xl tracking-wide md:min-h-24 md:px-16 md:text-4xl"
          >
            <span className="optical-center">Play</span>
          </Link>
          <p className="font-body text-sm font-semibold text-white/75">Free to play · no wallet needed · real players only</p>
        </Reveal>
      </div>
    </section>
  );
}

const CYCLE_MIN = Math.round(WORLD.CYCLE_MS / 60_000);
const ARM_MIN = Math.round(WORLD.EXTRACT_ARM_MS / 60_000);

const HOW: { sprite: string; title: string; body: string }[] = [
  {
    sprite: "pistol",
    title: "Drop in any time",
    body: `${BRAND.mapName} is always live: one map, wiped every ${CYCLE_MIN} minutes. Jump in whenever you like with the basic gear — pistol, light ammo, a bandage.`,
  },
  {
    sprite: "chest_epic",
    title: "Loot chests",
    body: "Crack chests for rifles, shotguns, snipers and armor. The shinier the chest, the better the loot.",
  },
  {
    sprite: "bush",
    title: "Fight or sneak",
    body: "Hunt other raiders for their gear or hide in the bushes and let them pass. Your call.",
  },
  {
    sprite: "backpack",
    title: "Reach an extraction point",
    body: `Extracts open for you ${ARM_MIN} min after you drop in. Hold your ground for ${MATCH.EXTRACT_CHANNEL_MS / 1000} s and everything you carry is yours.`,
  },
];

function HowItWorks() {
  return (
    <section className="bg-[#0d1119] px-4 py-20 md:px-8 md:py-28">
      <div className="mx-auto max-w-6xl">
        <Reveal as="h2" className="toon-text text-center text-5xl tracking-wide text-white md:text-6xl">
          How it works
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {HOW.map((h, i) => (
            <Reveal
              key={h.title}
              delay={i * 90}
              className="toon-panel relative flex flex-col items-center bg-[#1d2333] p-6 text-center"
            >
              <span className="toon-key absolute left-3 top-3 h-8 min-w-8 bg-zooa-lime text-base">{i + 1}</span>
              <Sprite name={h.sprite} className="h-28 w-28" />
              <h3 className="mt-4 text-xl tracking-wide text-zooa-lime">{h.title}</h3>
              <p className="font-body mt-3 text-[0.95rem] leading-relaxed text-white/75">{h.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const SHOWCASE: { weapon: WeaponId; rarity: 0 | 1 | 2 | 3 }[] = [
  { weapon: "rifle", rarity: 0 },
  { weapon: "shotgun", rarity: 1 },
  { weapon: "sniper", rarity: 2 },
  { weapon: "rifle", rarity: 3 },
];

function LootSection() {
  return (
    <section className="relative overflow-hidden bg-[#141a26] px-4 py-20 md:px-8 md:py-28">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 lg:grid-cols-2">
        <div>
          <Reveal as="h2" className="toon-text text-5xl tracking-wide text-white md:text-6xl">
            Loot that matters
          </Reveal>
          <Reveal as="p" delay={80} className="font-body mt-6 max-w-[52ch] text-lg leading-relaxed text-white/80">
            Four rarities, each hitting harder than the last. Gear only counts once you get it out — and if you
            go down, every item rolls a coin: {Math.round(BREAK_CHANCE_ON_DEATH * 100)}% it breaks for good,
            otherwise it drops by your body for the next raider to grab.
          </Reveal>
          <Reveal as="p" delay={140} className="font-body mt-4 max-w-[52ch] text-lg leading-relaxed text-white/80">
            The map wipes every {CYCLE_MIN} minutes. Still on it when the wipe hits? Everything you carry is
            lost.
          </Reveal>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {SHOWCASE.map((s, i) => {
            const color = rarityHex(s.rarity);
            return (
              <Reveal
                key={`${s.weapon}-${s.rarity}`}
                delay={i * 80}
                className="toon-panel flex flex-col items-center gap-2 p-4"
              >
                <div
                  className="grid h-32 w-full place-items-center overflow-hidden rounded-xl border-[3px] border-black"
                  style={{ background: `radial-gradient(circle at 50% 40%, ${color}dd, ${color}44 75%)` }}
                >
                  <Sprite name={s.weapon} className="h-36 w-48 max-w-none" />
                </div>
                <span className="toon-text-thin text-lg uppercase tracking-wider" style={{ color }}>
                  {RARITY_NAMES[s.rarity]}
                </span>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ComingSoon() {
  return (
    <section className="bg-gradient-to-b from-[#B8FF4A] to-[#E8F06A] px-6 py-20 text-center text-black md:py-24">
      <Reveal className="mx-auto flex max-w-4xl flex-col items-center">
        <Sprite name="chest_legendary" className="h-28 w-28 drop-shadow-[0_8px_0_rgba(0,0,0,0.25)]" />
        <h2 className="mt-4 text-balance text-4xl leading-[1.05] tracking-tight md:text-6xl">
          A real item economy
        </h2>
        <p className="font-body mt-6 max-w-[56ch] text-base font-semibold leading-relaxed text-black/75 md:text-lg">
          Your own stash, a player-to-player marketplace and items with real value, powered by iDos. Playing
          is free, and the game never pays out: every valuable you find was once lost by another raider.
        </p>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-[#0a100c] px-4 pb-8 pt-16 md:px-8">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-8">
        <div className="flex items-end gap-4">
          <Sprite name="rifle" className="h-20 w-28 -rotate-12" />
          <Sprite name="player" className="h-24 w-24" />
          <Sprite name="chest_rare" className="h-20 w-20" />
        </div>
        <Link href="/play" className="toon-btn min-h-16 px-10 text-2xl tracking-wide">
          <span className="optical-center">Drop in now</span>
        </Link>
        <div className="flex w-full items-center justify-between border-t-[3px] border-black pt-6 text-sm text-white/50">
          <span className="toon-text-thin text-lg tracking-wide text-zooa-lime">{BRAND.name}</span>
          <span className="font-body">Demo build</span>
        </div>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen bg-[#0a100c] text-white">
      <Hero />
      <Marquee />
      <HowItWorks />
      <LootSection />
      <ComingSoon />
      <Footer />
    </div>
  );
}
