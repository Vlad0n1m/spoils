/**
 * Pure helpers of the public /news page: ordering, anchors, tags, dates and the tiny inline
 * formatter for the page-only fields of content/news.ts (`**bold**` and `[label](href)`).
 * Run the tests: apps/game-server/node_modules/.bin/tsx --test apps/web/src/app/news/format.test.ts
 */
import type { NewsPost } from "../../content/news";

/** Newest first by `date` (YYYY-MM-DD sorts as text); posts of the same day keep their file order. */
export function sortNewestFirst<T extends Pick<NewsPost, "date">>(posts: readonly T[]): T[] {
  return posts
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.date === b.p.date ? a.i - b.i : a.p.date < b.p.date ? 1 : -1))
    .map(({ p }) => p);
}

/** The entry's fragment id on /news (/news#<anchor>): lowercase, [a-z0-9-] only. */
export function postAnchor(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "post";
}

/** The main tag first, then the extra tags, lowercase and without repeats or blanks. */
export function postTags(post: Pick<NewsPost, "tag" | "tags">): string[] {
  const out: string[] = [];
  for (const t of [post.tag, ...(post.tags ?? [])]) {
    const k = t.trim().toLowerCase();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-06" → "Oct 6, 2026" (a UTC day, so no timezone shift). Anything else is returned as is. */
export function fmtPostDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return date;
  return `${MONTHS[month - 1]} ${day}, ${m[1]}`;
}

export type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string; href: string };

/** Links may point inside the site ("/x", "#x") or to an https page; anything else stays text. */
function safeHref(href: string): string | null {
  if (/^\/(?!\/)/.test(href) || href.startsWith("#")) return href;
  if (/^https:\/\/[^\s]+$/i.test(href)) return href;
  return null;
}

const INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Splits a string into text, `**bold**` and `[label](href)` segments. Unmatched markers stay text. */
export function parseInline(text: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  const push = (seg: InlineSegment) => {
    const last = out[out.length - 1];
    if (seg.kind === "text" && last?.kind === "text") last.text += seg.text;
    else if (seg.text) out.push(seg);
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > at) push({ kind: "text", text: text.slice(at, i) });
    if (m[1] !== undefined) push({ kind: "strong", text: m[1] });
    else {
      const href = safeHref(m[3]);
      push(href ? { kind: "link", text: m[2], href } : { kind: "text", text: m[2] });
    }
    at = i + m[0].length;
  }
  if (at < text.length) push({ kind: "text", text: text.slice(at) });
  return out;
}

/** Plain text of a formatted string (markers removed), for metadata and summaries. */
export function plainInline(text: string): string {
  return parseInline(text)
    .map((s) => s.text)
    .join("");
}
