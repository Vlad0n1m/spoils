"use client";

import Link from "next/link";
import { useCallback } from "react";
import { useSession } from "@/lib/session-context";

const small = "min-h-9 rounded-xl border-[3px] px-3 text-xs lg:text-[0.8125rem] tracking-wide shadow-[0_3px_0_#000] active:translate-y-[2px] active:shadow-[0_1px_0_#000]";

export function AuthButton() {
  const { user, setUser } = useSession();

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setUser(null);
  }, [setUser]);

  if (user) {
    return (
      <div className="flex items-center gap-3">
        <span className="max-w-[10rem] truncate text-sm tracking-wide text-white/80">
          {user.nickname}
          {user.isGuest && <span className="ml-1.5 text-xs lg:text-[0.8125rem] text-white/70">guest</span>}
        </span>
        <button type="button" onClick={signOut} className={`toon-btn-ghost ${small}`}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Link href="/auth/login" className={`toon-btn ${small}`}>
        Sign in
      </Link>
      <Link href="/auth/register" className={`toon-btn-ghost ${small}`}>
        Register
      </Link>
    </div>
  );
}
