"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { EQUIP_KEYS, FREE_KIT, POCKET_SLOTS, itemDef, type LoadoutEntry } from "@extract/shared";
import type { StashResponse } from "@/lib/lobby/api-types";
import {
  LOADOUT_ERR_TEXT,
  bagCapacity,
  draftFromLocked,
  freeStacks,
  placeStack,
  placeUnique,
  pruneDraft,
  removeAt,
  setStackQty,
  usedUniqueIds,
  validateDraft,
  type StashView,
} from "@/lib/lobby/loadout-model";
import { describeItem } from "@/lib/items-ui";
import { flushDraft, registerDraftFlush, trackDraftSave } from "@/lib/lobby/draft-flush";
import { panelHref } from "@/lib/lobby/panels";
import { ItemCard, EmptySlot } from "./item-card";
import { StashList } from "./stash-list";
import { Paged } from "@/components/paged";
import { api } from "./use-lobby";
import { EDITION_UI } from "@/lib/edition";

const SLOT_LABEL: Record<string, string> = { w1: "Weapon 1", w2: "Weapon 2", armor: "Armor", bp: "Backpack" };
const SAVE_DEBOUNCE_MS = 600;

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Loadout tab (inventory memo "loadout-board"): stash on the left, the raid doll in the middle
 * (2 weapons, armor, backpack, 4 pockets, backpack grid sized by the equipped pack), summary on
 * the right. Click a stash item to auto-place it with the shared planPlace; click a slot to send
 * it back. The draft autosaves; PLAY in the main menu (POST /api/world/join) locks it for the raid.
 * While gear is locked or in a raid the board is read-only. `onDone` closes the Inventory panel
 * ("Save & close" flushes a pending autosave first).
 */
export function LoadoutBoard({ stash, reload, onDone }: { stash: StashResponse; reload: () => Promise<void>; onDone?: () => void }) {
  const view: StashView = useMemo(() => ({ uniques: stash.uniques, stacks: stash.stacks }), [stash]);
  const locked = stash.active;
  const [entries, setEntries] = useState<LoadoutEntry[]>(() =>
    locked ? draftFromLocked(locked.entries) : pruneDraft(stash.draft ?? [], view),
  );
  const [toast, setToast] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);

  // A reload that changes the lock state (unlock, raid settled) re-seeds the board from the server.
  const lockKey = locked ? `${locked.loadoutId}:${locked.status}` : "none";
  const seenLockKey = useRef(lockKey);
  useEffect(() => {
    if (seenLockKey.current === lockKey) return;
    seenLockKey.current = lockKey;
    dirty.current = false;
    setEntries(locked ? draftFromLocked(locked.entries) : pruneDraft(stash.draft ?? [], view));
  }, [lockKey, locked, stash.draft, view]);

  // Debounced autosave of the draft (only after a user edit, never for the read-only view).
  // `pending` holds an edit not yet sent, so leaving the tab inside the debounce still saves it.
  const pending = useRef<LoadoutEntry[] | null>(null);
  useEffect(() => {
    if (!dirty.current || locked) return;
    setSave("saving");
    pending.current = entries;
    const t = window.setTimeout(() => {
      const body = pending.current;
      pending.current = null;
      if (!body) return; // already sent by a flush (PLAY)
      trackDraftSave(api("/api/loadout/draft", { method: "PUT", body: { entries: body } }))
        .then(() => setSave("saved"))
        .catch(() => setSave("error"));
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [entries, locked]);
  // PLAY (armed auto-enter, the PLAY chip) first sends an edit still inside the debounce (draft-flush.ts).
  useEffect(
    () =>
      registerDraftFlush(async () => {
        const body = pending.current;
        if (!body) return;
        pending.current = null;
        await trackDraftSave(api("/api/loadout/draft", { method: "PUT", body: { entries: body } })).then(
          () => setSave("saved"),
          () => setSave("error"),
        );
      }),
    [],
  );
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(
    () => () => {
      if (pending.current) {
        // keepalive lets the request outlive the unmount / navigation.
        void trackDraftSave(
          fetch("/api/loadout/draft", {
            method: "PUT",
            credentials: "include",
            keepalive: true,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ entries: pending.current }),
          }),
        ).catch(() => {});
      }
      // The menu behind shows this draft (gear strip, PLAY's "N items at risk"): refetch the stash
      // once the saves landed, or a panel closed right after an edit keeps showing the old loadout.
      if (dirty.current) void flushDraft().then(() => reloadRef.current());
    },
    [],
  );

  const saveAndClose = async () => {
    setBusy(true);
    try {
      if (pending.current) {
        const body = { entries: pending.current };
        pending.current = null;
        await trackDraftSave(api("/api/loadout/draft", { method: "PUT", body }));
        setSave("saved");
      }
      setBusy(false);
      onDone?.();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not save the loadout");
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const edit = (next: LoadoutEntry[]) => {
    dirty.current = true;
    setEntries(next);
  };

  const readOnly = Boolean(locked);
  const free = freeStacks(view, entries);
  const used = usedUniqueIds(entries);
  const cap = bagCapacity(entries);
  const v = validateDraft(entries, view);
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const atRisk = entries.filter((e) => e.itemId).length;

  const pickUnique = (u: StashResponse["uniques"][number]) => {
    if (readOnly) return;
    if (u.state !== "in_stash") {
      setToast(u.state === "listed" && EDITION_UI.market ? "That item is listed on the market. Cancel the lot to equip it." : u.state === "listed" ? "That item is not in your stash right now." : "That item is locked in a raid.");
      return;
    }
    const r = placeUnique(entries, u);
    if (r.ok) edit(r.entries);
    else setToast(LOADOUT_ERR_TEXT[r.code]);
  };
  const pickStack = (def: string) => {
    if (readOnly) return;
    const r = placeStack(entries, def, free[def] ?? 0);
    if (r.ok) edit(r.entries);
    else setToast(LOADOUT_ERR_TEXT[r.code]);
  };
  const remove = (key: string) => {
    if (!readOnly) edit(removeAt(entries, key));
  };
  const step = (key: string, delta: number) => {
    const cur = byKey.get(key as LoadoutEntry["key"]);
    if (!readOnly && cur) edit(setStackQty(entries, key, cur.qty + delta, view));
  };

  const unlock = async () => {
    setBusy(true);
    try {
      await api("/api/loadout/unlock", { method: "POST" });
      await reload();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Unlock failed");
    } finally {
      setBusy(false);
    }
  };

  const slot = (key: string, size: "sm" | "md" | "lg" = "md") => {
    const e = byKey.get(key as LoadoutEntry["key"]);
    if (!e) return <EmptySlot label={SLOT_LABEL[key] ? "Empty" : key.startsWith("p") ? "Pocket" : ""} size={size} />;
    const u = e.itemId ? stash.uniques.find((x) => x.id === e.itemId) : undefined;
    const d = itemDef(e.def);
    const stackable = !e.itemId && (d?.stack ?? 1) > 1;
    return (
      <div className="flex flex-col items-center gap-1">
        <ItemCard
          def={e.def}
          rarity={u?.rarity}
          dur={u?.dur}
          qty={e.itemId ? undefined : e.qty}
          size={size}
          title={readOnly ? describeItem({ def: e.def, rarity: u?.rarity }).name : "Click to return to stash"}
          onClick={readOnly ? undefined : () => remove(key)}
        />
        {stackable && !readOnly && (
          <div className="flex items-center gap-1">
            <StepBtn label={`Less ${d?.name ?? ""}`} onClick={() => step(key, -1)}>
              −
            </StepBtn>
            <StepBtn label={`More ${d?.name ?? ""}`} onClick={() => step(key, 1)} disabled={(free[e.def] ?? 0) <= 0 || e.qty >= (d?.stack ?? 1)}>
              +
            </StepBtn>
          </div>
        )}
      </div>
    );
  };

  return (
    // Landscape: stash | raid gear | summary side by side, each column fits the height (lists page,
    // Save & close stays at the bottom); portrait phones stack them.
    <div className="flex min-h-0 flex-1 flex-col gap-3 land:grid land:grid-cols-[minmax(0,1fr)_minmax(0,19rem)_minmax(0,14rem)] short:!grid-cols-[minmax(0,1fr)_minmax(0,17.5rem)_minmax(0,12rem)] land:grid-rows-[minmax(0,1fr)] land:gap-4 short:!gap-2">
      <section className="toon-panel flex min-h-0 flex-1 flex-col bg-[#161b28]/95 p-5 short:p-3">
        <header className="flex shrink-0 items-baseline justify-between gap-3">
          <h2 className="toon-text-thin text-2xl tracking-wide text-white short:text-xl">Stash</h2>
          <p className="font-body text-xs lg:text-[0.8125rem] text-white/70">
            <span className="[@media(hover:none)]:hidden">Click to equip</span>
            <span className="hidden [@media(hover:none)]:inline">Tap to equip</span>
          </p>
        </header>
        <div className="mt-3 flex min-h-0 flex-1 flex-col short:mt-2">
          <StashList
            uniques={stash.uniques.filter((u) => u.state === "in_stash")}
            stacks={free}
            usedIds={used}
            onPickUnique={readOnly ? undefined : pickUnique}
            onPickStack={readOnly ? undefined : pickStack}
            compact
            emptyHint={
              <>
                Your stash is empty.{" "}
                {EDITION_UI.starterKitSale ? (
                  <Link
                    href={panelHref({ panel: "inventory", tab: "stash" })}
                    className="inline-flex min-h-11 items-center text-zooa-lime underline-offset-4 hover:underline"
                  >
                    Buy a starter kit
                  </Link>
                ) : (
                  <Link
                    href={panelHref({ panel: "shop", tab: "traders" })}
                    className="inline-flex min-h-11 items-center text-zooa-lime underline-offset-4 hover:underline"
                  >
                    Buy gear from the traders
                  </Link>
                )}
              </>
            }
          />
        </div>
      </section>

      <section className="toon-panel relative flex min-h-0 flex-col bg-[#161b28]/95 p-5 short:p-3">
        <header className="flex shrink-0 items-baseline justify-between gap-3">
          <h2 className="toon-text-thin text-2xl tracking-wide text-white short:text-xl">Raid gear</h2>
          {!readOnly && <SaveBadge state={save} />}
        </header>
        <Paged className="mt-3 short:mt-2" gap={12} label="Raid gear pages">
        <div className="grid grid-cols-4 justify-items-center gap-2">
          {EQUIP_KEYS.map((k) => (
            <div key={k} className="flex flex-col items-center gap-1.5">
              {slot(k, "md")}
              <span className="text-xs lg:text-[0.8125rem] uppercase tracking-wider text-white/70">{SLOT_LABEL[k]}</span>
            </div>
          ))}
        </div>
        <div>
          <h3 className="text-xs lg:text-[0.8125rem] uppercase tracking-[0.12em] text-white/70">Pockets</h3>
          <div className="mt-2 grid grid-cols-4 justify-items-center gap-2">
            {Array.from({ length: POCKET_SLOTS }, (_, i) => (
              <div key={i}>{slot(`p${i}`, "sm")}</div>
            ))}
          </div>
        </div>
        <div>
          <h3 className="text-xs lg:text-[0.8125rem] uppercase tracking-[0.12em] text-white/70">
            Backpack <span className="tabular-nums text-white/70">{cap > 0 ? `${entries.filter((e) => /^b\d/.test(e.key)).length}/${cap}` : "— none"}</span>
          </h3>
          {cap > 0 ? (
            <div className="mt-2 grid grid-cols-4 justify-items-center gap-2">
              {Array.from({ length: cap }, (_, i) => (
                <div key={i}>{slot(`b${i}`, "sm")}</div>
              ))}
            </div>
          ) : (
            <p className="font-body mt-2 text-sm text-white/70">Equip a backpack for more slots. Loot you find goes into pockets and the pack.</p>
          )}
        </div>
        </Paged>
        {toast && (
          <p role="status" className="font-body absolute inset-x-5 bottom-4 rounded-xl border-2 border-black bg-amber-300 px-3 py-2 text-sm font-semibold text-black shadow-[0_3px_0_#000]">
            {toast}
          </p>
        )}
      </section>

      <aside className="toon-panel flex min-h-0 flex-col bg-[#161b28]/95 p-5 short:p-3">
        <h2 className="toon-text-thin shrink-0 text-2xl tracking-wide text-white short:sr-only">Summary</h2>
        <Paged className="mt-4 short:mt-0" gap={12} label="Summary pages">
        {locked ? (
          <div className="rounded-2xl border-2 border-black bg-amber-300 p-4 text-black">
            <p className="text-sm tracking-wide">{locked.status === "in_raid" ? "Gear is in a raid" : "Locked for your next drop"}</p>
            <p className="font-body mt-1 text-sm">
              {locked.status === "in_raid"
                ? "It comes back to your stash when you extract (or is lost if you die)."
                : "This loadout is reserved for your next raid. Unlock it to make changes."}
            </p>
            {locked.status === "locked" && (
              <button type="button" onClick={unlock} disabled={busy} className="toon-btn-ghost mt-3 min-h-10 w-full text-sm">
                <span className="optical-center">{busy ? "Unlocking…" : "Unlock"}</span>
              </button>
            )}
          </div>
        ) : v.ok ? (
          <p className="font-body rounded-xl border-2 border-black bg-zooa-lime/90 px-3 py-2 text-sm font-semibold text-black">Ready to drop in.</p>
        ) : (
          <p className="font-body rounded-xl border-2 border-black bg-rose-300 px-3 py-2 text-sm font-semibold text-black" role="alert">
            {LOADOUT_ERR_TEXT[v.code]}
          </p>
        )}
        <dl className="font-body grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-white/70">Gear at risk</dt>
          <dd className="text-right tabular-nums text-white">
            {atRisk} {atRisk === 1 ? "item" : "items"}
          </dd>
          <dt className="text-white/70">Ammo</dt>
          <dd className="text-right tabular-nums text-white">{entries.filter((e) => itemDef(e.def)?.cat === "ammo").reduce((s, e) => s + e.qty, 0)}</dd>
          <dt className="text-white/70">Meds</dt>
          <dd className="text-right tabular-nums text-white">{entries.filter((e) => itemDef(e.def)?.cat === "med").reduce((s, e) => s + e.qty, 0)}</dd>
          <dt className="text-white/70">Grenades</dt>
          <dd className="text-right tabular-nums text-white">{entries.filter((e) => itemDef(e.def)?.cat === "throwable").reduce((s, e) => s + e.qty, 0)}</dd>
        </dl>
        <p className="font-body text-sm leading-relaxed text-white/75 short:text-xs short:leading-snug">
          {entries.length === 0
            ? `Empty loadout = basic gear: a pistol, ${FREE_KIT.AMMO_LIGHT} light ammo and a bandage. You can't lose it, but it adds no gear to the map's crates: only raiders who bring their own gear do.`
            : "Die and each item has a 50% chance to break into the lost pool; the rest stays in your body for whoever finds it. Extract to keep everything."}
        </p>
        </Paged>
        <div className="mt-3 flex shrink-0 flex-col gap-2 short:mt-2">
          {!readOnly && entries.length > 0 && (
            <button type="button" onClick={() => edit([])} className="toon-btn-ghost min-h-11 text-sm short:min-h-9">
              <span className="optical-center">Clear</span>
            </button>
          )}
          {onDone && (
            <button
              type="button"
              onClick={saveAndClose}
              disabled={busy || (!v.ok && !readOnly)}
              className="toon-btn min-h-14 text-xl tracking-wide short:min-h-11 short:text-lg"
            >
              <span className="optical-center">{readOnly ? "Close" : busy ? "Saving…" : "Save & close"}</span>
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

function StepBtn({ children, onClick, disabled, label }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="grid h-6 w-6 place-items-center rounded-md border-2 border-black bg-white text-sm text-black shadow-[0_2px_0_#000] disabled:opacity-40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:text-lg short:[@media(pointer:coarse)]:h-9 short:[@media(pointer:coarse)]:w-9"
    >
      {children}
    </button>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  return (
    <span
      className={clsx(
        "font-body text-xs lg:text-[0.8125rem]",
        state === "saving" && "text-white/70",
        state === "saved" && "text-zooa-lime",
        state === "error" && "text-rose-300",
      )}
    >
      {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Not saved — retrying on next change"}
    </span>
  );
}
