import { requireAdminPage } from "@/lib/admin/server";

export const dynamic = "force-dynamic";

/** /admin/replays: placeholder until the replay viewer lands (its API lives under /api/admin/replays). */
export default async function AdminReplaysPage() {
  await requireAdminPage();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold md:text-3xl">Повторы</h1>
      <section className="rounded-xl border border-dashed border-white/20 bg-[#141925] p-5">
        <p className="text-sm leading-relaxed text-white/65">
          Просмотр повторов матчей появится здесь позже. Пока споры разбираем по журналам: raid_exits, pvp_kills,
          item_events.
        </p>
      </section>
    </div>
  );
}
