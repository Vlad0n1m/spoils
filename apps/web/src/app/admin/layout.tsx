import type { Metadata } from "next";
import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { requireAdminPage } from "@/lib/admin/server";
import { AdminNav } from "./admin-nav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Admin — ${BRAND.name}`,
  robots: { index: false, follow: false },
};

/**
 * /admin shell. 404 for anyone who is not a signed-in admin (users.role = 'admin', README «Админка»);
 * every page under it repeats the check, because Next renders a layout and its page in parallel.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdminPage();
  return (
    <div className="font-body min-h-[100dvh] bg-[#0b0f14] leading-normal text-white">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-[#0b0f14]/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 md:px-6">
          <Link href="/admin" className="inline-flex min-h-[44px] items-center text-sm font-bold tracking-wide text-zooa-lime">
            {BRAND.name} · админка
          </Link>
          <AdminNav />
          <span className="ml-auto truncate text-xs text-white/50">
            {admin.nickname} ·{" "}
            <Link href="/play" className="underline decoration-white/30 underline-offset-2 hover:text-white">
              в игру
            </Link>
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6 md:py-8">{children}</main>
    </div>
  );
}
