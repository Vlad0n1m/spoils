/**
 * next/link for the static iDos client (vite.config.ts alias). Links inside the lobby (/play?panel=…)
 * stay in the page; every other page of the site (news, rules, sign-in) opens on our own server in a
 * new tab, since only the game is hosted on iDos.
 */
import { forwardRef, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { externalHref } from "../api";
import { isPlayHref } from "../nav";
import { navigate } from "./next-navigation";

type Href = string | { pathname?: string; query?: Record<string, string | number | undefined> };

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: Href;
  replace?: boolean;
  prefetch?: boolean | null;
  scroll?: boolean;
  children?: ReactNode;
}

function hrefString(href: Href): string {
  if (typeof href === "string") return href;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(href.query ?? {})) if (v !== undefined) q.set(k, String(v));
  const qs = q.toString();
  return `${href.pathname ?? ""}${qs ? `?${qs}` : ""}`;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, replace, prefetch: _prefetch, scroll: _scroll, onClick, children, ...rest },
  ref,
) {
  const h = hrefString(href);
  if (isPlayHref(h)) {
    const click = (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(h, !!replace);
    };
    return (
      <a ref={ref} href={h} onClick={click} {...rest}>
        {children}
      </a>
    );
  }
  const external = h.startsWith("/");
  return (
    <a ref={ref} href={external ? externalHref(h) : h} onClick={onClick} {...(external ? { target: "_blank", rel: "noopener" } : {})} {...rest}>
      {children}
    </a>
  );
});

export default Link;
