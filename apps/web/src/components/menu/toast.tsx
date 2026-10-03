"use client";

import { useLobby } from "@/lib/lobby/lobby-context";

/**
 * The menu's one toast (locked buttons, small confirmations): bottom centre above PLAY, 2.5 s,
 * announced politely. Shown through `useLobby().toast(text)`.
 */
export function MenuToast() {
  const { toastText } = useLobby();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-36 z-[55] flex justify-center px-4 md:bottom-40" role="status" aria-live="polite">
      {toastText && (
        <p
          key={toastText}
          className="font-body rounded-2xl border-[3px] border-black bg-white px-4 py-2.5 text-sm font-bold text-black shadow-[0_4px_0_#000] animate-pop-in motion-reduce:animate-none"
        >
          {toastText}
        </p>
      )}
    </div>
  );
}
