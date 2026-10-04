import type { Metadata } from "next";
import Link from "next/link";
import { TopBar } from "@/components/top-bar";
import { ALPHA_BUG_CHANNEL_URL, ALPHA_WIPE_DATE, alphaWipeText } from "@/content/alpha";
import { BRAND } from "@/lib/brand";

const DESCRIPTION = `${BRAND.name} alpha rules: a test balance with no real money, nothing to earn, one item wipe at the end, and what you keep after it.`;

export const metadata: Metadata = {
  title: `Alpha rules — ${BRAND.name}`,
  description: DESCRIPTION,
  openGraph: { title: `${BRAND.name} alpha rules`, description: DESCRIPTION, type: "website", siteName: BRAND.name },
};

type Item = React.ReactNode;

function Section({ id, title, tone = "text-zooa-lime", items, children }: { id: string; title: string; tone?: string; items: Item[]; children?: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="toon-panel scroll-mt-20 bg-[#161b28]/95 p-4 md:p-6">
      <h2 id={`${id}-title`} className={`toon-text-thin text-2xl leading-tight tracking-wide md:text-3xl ${tone}`}>
        {title}
      </h2>
      <ul className="font-body mt-3 list-disc space-y-2.5 pl-5 text-[0.95rem] leading-snug text-white/80 marker:text-white/50 md:text-base">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
      {children}
    </section>
  );
}

const linkCls = "font-semibold text-zooa-lime underline decoration-2 underline-offset-2 hover:text-white";

/**
 * Public /alpha (docs/ALPHA_PLAN.md B12): the alpha rules in plain English. Server-rendered, no client
 * JS of its own. Linked from the register page and the menu's Info panel. The wipe date and the bug
 * channel come from content/alpha.ts.
 */
export default function AlphaRulesPage() {
  const wipe = alphaWipeText();
  return (
    <div className="min-h-[100dvh] bg-[#0b0f14] text-white">
      <TopBar />
      <main className="mx-auto w-full max-w-3xl px-4 pb-12 pt-6 md:px-6 md:pt-10">
        <p className="text-xs uppercase tracking-[0.25em] text-white/70 lg:text-[0.8125rem]">Alpha test</p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <h1 className="toon-text text-4xl tracking-wide text-zooa-lime md:text-6xl">Alpha rules</h1>
          <Link href="/play" className="toon-btn-ghost min-h-11 px-4 text-sm">
            <span className="optical-center">← Back to the menu</span>
          </Link>
        </div>
        <p className="font-body mt-3 max-w-[62ch] text-base leading-relaxed text-white/75">
          {BRAND.name} is in alpha: we are testing the game, the economy and the servers with real players before the first
          season. Please read this once — it is short.
        </p>

        <div className="mt-6 rounded-xl border-[3px] border-black bg-amber-300 p-4 text-black md:p-5">
          <p className="text-xs font-bold uppercase tracking-[0.18em] lg:text-[0.8125rem]">In short</p>
          <ul className="font-body mt-2 list-disc space-y-2 pl-5 text-[0.95rem] font-semibold leading-relaxed md:text-base">
            <li>It runs on a test balance. No real money goes in or out.</li>
            <li>Nothing here can be earned or cashed out.</li>
            <li>One item wipe at the end of the alpha ({wipe}).</li>
            <li>Your level, cosmetics and Alpha Pass rewards survive the wipe.</li>
          </ul>
        </div>

        <nav aria-label="Sections" className="font-body mt-6 flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {[
            ["balance", "Test balance"],
            ["earn", "No earning"],
            ["wipe", "The wipe"],
            ["keep", "What you keep"],
            ["bugs", "Bugs"],
            ["fair", "Fair play"],
            ["data", "Your data"],
          ].map(([id, label]) => (
            <a key={id} href={`#${id}`} className="font-semibold text-white/80 underline decoration-white/30 underline-offset-4 hover:text-zooa-lime">
              {label}
            </a>
          ))}
        </nav>

        <div className="mt-6 flex flex-col gap-5">
          <Section
            id="balance"
            title="A test balance, not real money"
            items={[
              "Your market balance in the alpha is test money. You cannot deposit real money and you cannot withdraw any.",
              "The starter kit and market trades are paid from that test balance, so the economy can be tested the way it will work later.",
              "CR (credits) is the in-game currency for traders and fees. It never turns into money.",
            ]}
          />
          <Section
            id="earn"
            title="Nothing can be earned"
            items={[
              "The alpha has no payouts of any kind. Items, CR and the test balance have no cash value.",
              "The game never pays anyone from its own wallet. Everything it takes in is shown on the Economy page.",
              <>
                Do not buy or sell alpha accounts or items for real money: they will be wiped. See the open numbers on{" "}
                <Link href="/economy" className={linkCls}>
                  Economy
                </Link>
                .
              </>,
            ]}
          />
          <Section
            id="wipe"
            title="One item wipe at the end"
            tone="text-amber-300"
            items={[
              <>
                At the end of the alpha we wipe once. Date: <strong className="font-extrabold text-white">{wipe}</strong>.
                {ALPHA_WIPE_DATE ? null : " We announce it at least 7 days ahead in News and in the game menu."}
              </>,
              "The wipe removes items (stash, gear, listings), stacks of ammo and meds, CR and the test balance.",
              "There is only one wipe for the whole alpha. The 45-minute map resets are part of the game and are not wipes.",
            ]}
          />
          <Section
            id="keep"
            title="What you keep after the wipe"
            items={[
              "Your account, nickname, level and XP.",
              "Cosmetics you unlocked: titles, name colours, badge frames and skins.",
              "Alpha Pass progress and every reward you claimed — including the Alpha Raider title, the Founder badge and the Alpha Top 10 trophy.",
            ]}
          />
          <Section
            id="bugs"
            title="Found a bug? Tell us"
            items={[
              "Use Report a bug in the Alpha Pass in the game menu. Say what happened, the map number and roughly when (UTC). An accepted report also completes the bug tester task.",
              ALPHA_BUG_CHANNEL_URL ? (
                <>
                  Or write to the{" "}
                  <a href={ALPHA_BUG_CHANNEL_URL} target="_blank" rel="noopener noreferrer" className={linkCls}>
                    bug channel
                  </a>
                  .
                </>
              ) : (
                "A public bug channel is coming soon; we will link it here."
              ),
              "We aim to answer every report within a day. If you lose an item because of our bug, we give it back.",
              <>
                Known issues and fixes are listed in the{" "}
                <Link href="/news" className={linkCls}>
                  patch notes
                </Link>
                .
              </>,
            ]}
          />
          <Section
            id="fair"
            title="Fair play"
            tone="text-rose-300"
            items={[
              "No cheats, hacks, bots, macros or exploits. If you find an exploit, report it instead of using it.",
              "One account per person. No second accounts to farm items, CR or Alpha Pass rewards, and no passing loot between your own accounts.",
              "No arranged kills or trading wins with friends to farm rewards.",
              "Breaking these rules can get your account banned and its items, CR and rewards rolled back. Every item move is journaled, so we can.",
            ]}
          />
          <Section
            id="data"
            title="What data we keep"
            items={[
              "Your email, nickname and a password hash (never the password itself), a wallet address if you link one, and your raids, kills, extracts and leaderboard stats.",
              "Every item and currency change, in a journal, so lost items can be returned and cheating can be found.",
              "Map replays: every map is recorded with each player's position, nickname and account id. Replays are visible only to the team (admins) and are deleted after 14 days.",
              "Bug reports and survey answers you send. We never sell your data.",
            ]}
          />
        </div>

        <p className="font-body mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/75">
          <Link href="/play" className="hover:text-zooa-lime">
            Play →
          </Link>
          <Link href="/news" className="hover:text-zooa-lime">
            Patch notes →
          </Link>
          <Link href="/economy" className="hover:text-zooa-lime">
            Economy →
          </Link>
        </p>
      </main>
    </div>
  );
}
