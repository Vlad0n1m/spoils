"use client";

import Link from "next/link";
import { useCallback } from "react";
import { useSession } from "@/lib/session-context";

export function AuthButton() {
  const { user, setUser } = useSession();

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setUser(null);
  }, [setUser]);

  if (user) {
    return (
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-white/60">{user.nickname}</span>
        <button type="button" onClick={signOut} className="btn-ghost text-xs">
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Link href="/auth/login" className="btn-primary text-xs">
        Sign in
      </Link>
      <Link href="/auth/register" className="btn-ghost text-xs">
        Register
      </Link>
    </div>
  );
}
