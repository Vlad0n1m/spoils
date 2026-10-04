"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin", label: "Метрики" },
  { href: "/admin/params", label: "Стоп-краны" },
  { href: "/admin/replays", label: "Повторы" },
  { href: "/admin/testers", label: "Тестеры" },
] as const;

/** /admin section tabs (client only for the active state). */
export function AdminNav() {
  const path = usePathname();
  return (
    <nav aria-label="Разделы админки" className="flex gap-1 overflow-x-auto">
      {LINKS.map((l) => {
        const active = l.href === "/admin" ? path === "/admin" : path?.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-h-[44px] items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-colors ${
              active ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/5 hover:text-white"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
