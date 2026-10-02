import Image from "next/image";
import Link from "next/link";
import { Reveal } from "@/components/reveal";

const HERO = "/hero.png";
const FEAT_ORBS = "/feature-orbs.png";
const FEAT_EXTRACT = "/feature-extract.png";
const SNAKE = "/snake.png";

function ZooaIcon() {
  return (
    <span className="inline-flex h-9 w-9 shrink-0" aria-hidden>
      <svg viewBox="0 0 40 40" className="h-9 w-9" fill="none">
        <circle cx="20" cy="20" r="15" stroke="white" strokeWidth="1.5" className="text-white" />
        <path
          d="M 20 5 A 15 15 0 0 0 5 20 L 5 5 Z"
          fill="currentColor"
          className="text-zooa-lime"
        />
      </svg>
    </span>
  );
}

function LandingNav() {
  return (
    <header className="absolute left-0 right-0 top-0 z-50 flex min-h-12 items-center justify-between px-4 py-2.5 md:min-h-14 md:px-8 md:py-3">
      <Reveal delay={0}>
        <Link href="/" className="flex items-center gap-2.5 text-white">
          {/* <ZooaIcon /> */}
          <span className="font-display text-xl tracking-wide md:text-2xl">
            <span className="optical-center">ZOOA</span>
          </span>
        </Link>
      </Reveal>
    </header>
  );
}

function Marquee() {
  const items = Array.from({ length: 32 }, () => "PLAY TO EARN");
  const track = (
    <div className="flex w-max items-center">
      {items.map((t, i) => (
        <span
          key={i}
          className="font-display mx-5 text-sm tracking-[0.18em] text-black md:text-base"
        >
          {t}
        </span>
      ))}
    </div>
  );
  return (
    <div className="relative w-full overflow-hidden border-y border-[#bfff33]/60 bg-zooa-lime py-3">
      <div className="flex w-max animate-marquee">
        {track}
        {track}
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen bg-zooa-dark text-white">
      <section className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-[#090b08]">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[85dvh] min-h-[32rem] bg-[radial-gradient(ellipse_120%_90%_at_50%_-10%,#4a6b1e_0%,#2d4411_22%,#162208_48%,#090b08_78%)]"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-0 animate-twinkle opacity-[0.18] motion-reduce:animate-none"
          style={{
            backgroundImage:
              "radial-gradient(1px 1px at 8% 10%, rgba(255,255,255,0.55), transparent), radial-gradient(1px 1px at 32% 24%, rgba(220,255,180,0.4), transparent), radial-gradient(1px 1px at 68% 18%, rgba(255,255,255,0.45), transparent), radial-gradient(1px 1px at 88% 38%, rgba(200,255,160,0.35), transparent), radial-gradient(1.5px 1.5px at 18% 52%, rgba(255,255,255,0.3), transparent)",
            backgroundSize: "100% 100%",
          }}
          aria-hidden
        />

        <LandingNav />

        <div className="relative z-10 flex min-h-0 flex-1 flex-col px-3 pt-14 md:px-6 md:pt-16">
          <Reveal delay={100} className="mx-auto w-full max-w-[min(100%,48rem)] md:max-w-4xl">
            <div
              className="relative h-[min(68dvh,44rem)] w-full min-h-[20rem] animate-float sm:min-h-[26rem] motion-reduce:animate-none"
              style={{ animationDelay: "700ms" }}
            >
              <Image
                src={HERO}
                alt=""
                fill
                className="object-contain object-center"
                priority
                sizes="(max-width: 768px) 96vw, 56rem"
              />
            </div>
          </Reveal>

          <Reveal delay={350} className="-mt-6 flex justify-center md:-mt-10">
            <Link
              href="/play"
              className="font-display relative inline-flex min-w-[14rem] animate-glow-pulse items-center justify-center rounded-full bg-zooa-lime px-16 py-5 text-2xl tracking-[0.1em] text-black transition hover:scale-[1.03] hover:brightness-105 active:scale-[0.98] motion-reduce:animate-none sm:min-w-[16rem] sm:px-20 sm:py-6 sm:text-3xl md:min-w-[18rem] md:px-24 md:py-7 md:text-4xl"
            >
              <span className="optical-center">PLAY TO EARN</span>
            </Link>
          </Reveal>

          <div className="mt-6 flex flex-1 flex-col items-center justify-end pb-12 text-center md:mt-10 md:pb-16">
            <Reveal
              as="p"
              delay={550}
              className="max-w-[min(100%,42rem)] text-balance text-3xl leading-[1.08] tracking-wide text-[#c4f07a] sm:text-4xl md:max-w-4xl md:text-5xl lg:text-6xl"
            >
              Get a payout for your skill in PvP battle royale
            </Reveal>
          </div>
        </div>
      </section>

      <section className="bg-black">
        <div className="grid grid-cols-1 gap-2 px-2 md:grid-cols-2 md:gap-3 md:px-3">
          <Reveal
            delay={0}
            className="group relative flex min-h-[22rem] items-start justify-center overflow-hidden rounded-[2rem] bg-zooa-dark/80 bg-cover bg-center bg-no-repeat transition duration-500 hover:scale-[1.01] hover:brightness-110 md:min-h-[34rem] md:rounded-[2.5rem] lg:min-h-[40rem]"
          >
            <div
              className="absolute inset-0 bg-cover bg-center bg-no-repeat transition-transform duration-[1.2s] ease-out group-hover:scale-[1.04]"
              style={{ backgroundImage: `url(${FEAT_ORBS})` }}
            />
          </Reveal>
          <Reveal
            delay={150}
            className="group relative flex min-h-[22rem] items-start justify-center overflow-hidden rounded-[2rem] bg-zooa-dark/80 bg-cover bg-center bg-no-repeat transition duration-500 hover:scale-[1.01] hover:brightness-110 md:min-h-[34rem] md:rounded-[2.5rem] lg:min-h-[40rem]"
          >
            <div
              className="absolute inset-0 bg-cover bg-center bg-no-repeat transition-transform duration-[1.2s] ease-out group-hover:scale-[1.04]"
              style={{ backgroundImage: `url(${FEAT_EXTRACT})` }}
            />
          </Reveal>
        </div>
        <Reveal delay={200} className="mt-2 md:mt-3">
          <Marquee />
        </Reveal>
      </section>

      <section className="h-20vh flex flex-col items-center justify-center bg-gradient-to-b from-[#B8FF4A] to-[#E8F06A] px-6 py-20 text-center text-black">
        <Reveal
          as="h2"
          className="font-display max-w-4xl text-balance text-3xl leading-[1.05] tracking-tight sm:text-4xl md:text-5xl lg:text-6xl"
        >
         The First PLAY to EARN extraction battle royale
        </Reveal>
      </section>

      <footer className="relative overflow-hidden bg-[#050807] pb-6 pt-16 md:pb-10 md:pt-24">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 70% 50% at 50% 55%, rgba(220, 90, 40, 0.22) 0%, transparent 60%)",
          }}
          aria-hidden
        />
        <div className="relative flex h-[min(80vh,38rem)] min-h-[min(80vh,38rem)] flex-col items-center justify-center overflow-hidden px-4">
          <Reveal
            delay={0}
            className="pointer-events-none absolute inset-x-0 top-1/2 z-0 -translate-y-1/2"
          >
            <p
              className="font-pixel animate-text-breathe w-screen select-none whitespace-nowrap text-center font-normal leading-none tracking-[-0.02em] text-[#d4a017] opacity-95 motion-reduce:animate-none"
              style={{ fontSize: "clamp(1.25rem, 9.2vw, 12rem)" }}
              aria-hidden
            >
              EAT AND CONQUER
            </p>
          </Reveal>
          <Reveal
            delay={200}
            className="relative z-10 flex h-[80%] w-full items-end justify-center"
          >
            <div
              className="relative h-full w-full max-w-5xl animate-float-sm motion-reduce:animate-none"
              style={{ animationDelay: "500ms" }}
            >
              <Image
                src={SNAKE}
                alt=""
                fill
                priority={false}
                className="object-contain object-bottom drop-shadow-[0_8px_32px_rgba(0,0,0,0.6)]"
                sizes="(max-width: 768px) 100vw, 1024px"
              />
            </div>
          </Reveal>
        </div>
        <div className="relative z-20 mx-4 mt-12 flex items-center justify-between rounded-2xl border border-white/10 bg-black/80 px-6 py-5 backdrop-blur md:mx-8 md:mt-20 md:px-10 md:py-6">
          <Reveal delay={0}>
            <Link href="/" className="flex items-center gap-2.5 text-white">
              {/* <ZooaIcon /> */}
              <span className="font-display text-lg tracking-wide">
                <span className="optical-center">ZOOA</span>
              </span>
            </Link>
          </Reveal>
          <Reveal delay={120}>
            <Link
              href="/play"
              className="font-display inline-flex min-w-[5.5rem] items-center justify-center rounded-full bg-zooa-lime px-6 py-2 text-base tracking-[0.06em] text-black shadow-[0_8px_28px_rgba(204,255,0,0.45)]"
            >
              <span className="optical-center">PLAY TO EARN</span>
            </Link>
          </Reveal>
        </div>
      </footer>
    </div>
  );
}
