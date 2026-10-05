import type { Metadata } from "next";
import Link from "next/link";
import { TopBar } from "@/components/top-bar";
import { BRAND } from "@/lib/brand";
import { EDITION_UI } from "@/lib/edition";
import { SITE_URL } from "@/lib/site-url";
import { NEWS_POSTS, type NewsPost } from "@/content/news";
import { fmtPostDate, parseInline, postAnchor, postTags, sortNewestFirst } from "./format";

const DESCRIPTION = `What's new in ${BRAND.name}: patch notes, world updates and fixes for ${BRAND.mapName}.`;

export const metadata: Metadata = {
  title: `Patch notes — ${BRAND.name}`,
  description: DESCRIPTION,
  openGraph: {
    title: `${BRAND.name} patch notes`,
    description: DESCRIPTION,
    type: "website",
    siteName: BRAND.name,
    // Absolute URLs need the layout's metadataBase (NEXT_PUBLIC_SITE_URL); without it, none are sent.
    ...(SITE_URL ? { url: "/news", images: [{ url: "/feature-extract.png", width: 1264, height: 848, alt: `${BRAND.name} raid` }] } : {}),
  },
  twitter: {
    card: SITE_URL ? "summary_large_image" : "summary",
    title: `${BRAND.name} patch notes`,
    description: DESCRIPTION,
    ...(SITE_URL ? { images: ["/feature-extract.png"] } : {}),
  },
};

const TAG_TONE: Record<string, string> = {
  update: "bg-zooa-lime text-black",
  event: "bg-rose-500 text-black",
  fix: "bg-sky-300 text-black",
};

/** `**bold**` and `[label](href)` of the page-only fields; internal links stay in the app. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((s, i) => {
        if (s.kind === "strong")
          return (
            <strong key={i} className="font-extrabold text-white">
              {s.text}
            </strong>
          );
        if (s.kind === "link") {
          const cls = "font-semibold text-zooa-lime underline decoration-2 underline-offset-2 hover:text-white";
          return s.href.startsWith("https://") ? (
            <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className={cls}>
              {s.text}
            </a>
          ) : (
            <Link key={i} href={s.href} className={cls}>
              {s.text}
            </Link>
          );
        }
        return <span key={i}>{s.text}</span>;
      })}
    </>
  );
}

function Post({ post, latest }: { post: NewsPost; latest: boolean }) {
  const anchor = postAnchor(post.id);
  return (
    <article id={anchor} aria-labelledby={`${anchor}-title`} className="toon-panel scroll-mt-20 bg-[#161b28]/95 p-4 md:p-6">
      <p className="flex flex-wrap items-center gap-2 text-xs lg:text-[0.8125rem] tracking-[0.12em] text-white/75">
        {postTags(post).map((t) => (
          <span key={t} className={`rounded-md border-2 border-black px-1.5 py-0.5 ${TAG_TONE[t] ?? "bg-white/85 text-black"}`}>
            {t.toUpperCase()}
          </span>
        ))}
        <time dateTime={post.date} className="font-body text-xs lg:text-[0.8125rem] font-semibold tracking-normal text-white/75">
          {fmtPostDate(post.date)}
        </time>
        {latest && <span className="font-body text-xs lg:text-[0.8125rem] font-semibold tracking-normal text-amber-300">Latest</span>}
      </p>

      <h2 id={`${anchor}-title`} className="toon-text-thin mt-3 text-2xl leading-tight tracking-wide text-white md:text-3xl">
        <a href={`#${anchor}`} className="group hover:text-zooa-lime focus-visible:text-zooa-lime">
          {post.title}
          <span aria-hidden className="ml-2 text-white/30 transition-colors group-hover:text-zooa-lime">
            #
          </span>
        </a>
      </h2>

      {post.intro && (
        <p className="font-body mt-3 max-w-[65ch] text-base leading-relaxed text-white/80">
          <Inline text={post.intro} />
        </p>
      )}

      <div className="mt-4 rounded-xl border-[3px] border-black bg-black/25 p-3 md:p-4">
        <p className="text-xs lg:text-[0.8125rem] tracking-[0.12em] text-white/70">IN SHORT</p>
        <ul className="font-body mt-2 list-disc space-y-3 pl-5 text-[0.95rem] leading-snug text-white/80 marker:text-zooa-lime">
          {post.body.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </div>

      {post.sections?.map((s) => (
        <section key={s.heading} className="mt-5">
          <h3 className="toon-text-thin text-lg tracking-wide text-zooa-lime md:text-xl">{s.heading}</h3>
          <ul className="font-body mt-2 list-disc space-y-3 pl-5 text-[0.95rem] leading-snug text-white/75 marker:text-white/60">
            {s.items.map((it) => (
              <li key={it}>
                <Inline text={it} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}

/**
 * Public /news: every patch note of content/news.ts, newest first, server-rendered with no client
 * JS of its own. Each entry is linkable at /news#<id>. The menu News panel shows the same posts.
 */
export default function NewsPage() {
  const posts = sortNewestFirst(NEWS_POSTS);
  return (
    <div className="min-h-[100dvh] bg-[#0b0f14] text-white">
      <TopBar />
      <main className="mx-auto w-full max-w-3xl px-4 pb-12 pt-6 md:px-6 md:pt-10">
        <p className="text-xs lg:text-[0.8125rem] uppercase tracking-[0.25em] text-white/70">Patch notes</p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <h1 className="toon-text text-4xl tracking-wide text-zooa-lime md:text-6xl">News</h1>
          <Link href="/play" className="toon-btn-ghost min-h-11 px-4 text-sm">
            <span className="optical-center">← Back to the menu</span>
          </Link>
        </div>
        <p className="font-body mt-3 max-w-[62ch] text-base leading-relaxed text-white/70">
          What changed in {BRAND.name}, newest first. Live events like boss spawns and wipes are in the News feed inside the
          game menu.
        </p>

        {posts.length > 1 && (
          <nav aria-label="All posts" className="toon-panel mt-6 bg-[#161b28]/95 p-4">
            <ul className="font-body flex flex-col gap-1.5 text-sm">
              {posts.map((p) => (
                <li key={p.id} className="flex gap-3">
                  <time dateTime={p.date} className="w-24 shrink-0 text-white/70">
                    {fmtPostDate(p.date)}
                  </time>
                  <a href={`#${postAnchor(p.id)}`} className="font-semibold text-white/85 hover:text-zooa-lime">
                    {p.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {posts.length === 0 ? (
          <p className="toon-panel font-body mt-6 bg-[#161b28]/95 p-6 text-center text-white/70">No patch notes yet.</p>
        ) : (
          <div className="mt-6 flex flex-col gap-6">
            {posts.map((p, i) => (
              <Post key={p.id} post={p} latest={i === 0} />
            ))}
          </div>
        )}

        <p className="font-body mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/75">
          <Link href="/" className="hover:text-zooa-lime">
            {BRAND.name} home →
          </Link>
          {EDITION_UI.economyLinks && (
            <Link href="/economy" className="hover:text-zooa-lime">
              Economy →
            </Link>
          )}
        </p>
      </main>
    </div>
  );
}
