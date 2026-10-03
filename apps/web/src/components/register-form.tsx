"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession, type MeUser } from "@/lib/session-context";
import { parseJsonResponse } from "@/lib/parse-json-response";
import { authErrorMessage } from "@/lib/auth-error-messages";
import { safeAuthRedirect } from "@/lib/safe-auth-redirect";
import { Reveal } from "@/components/reveal";
import { authInputClass, authLabelClass } from "@/components/auth-field-styles";
import { BRAND } from "@/lib/brand";

const glass =
  "rounded-[2rem] border border-white/10 bg-zooa-dark/80 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_20px_40px_-15px_rgba(0,0,0,0.35)] backdrop-blur md:p-8";

export function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading, refresh, setUser } = useSession();
  const [email, setEmail] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextPath = safeAuthRedirect(searchParams.get("next"));

  useEffect(() => {
    if (user && !user.isGuest) {
      router.replace(nextPath);
    }
  }, [user, router, nextPath]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, nickname, password }),
      });
      const data = (await parseJsonResponse(r)) as {
        status?: string;
        error?: string;
        user?: MeUser;
      };
      if (data.status === "ok" && data.user) {
        setUser(data.user);
        await refresh();
        router.replace(nextPath);
        return;
      }
      if (data.error === "already_logged_in") {
        await refresh();
        router.replace(nextPath);
        return;
      }
      setError(authErrorMessage(data.error));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "network_error");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-16 text-center text-white/55 md:px-6">
        Loading…
      </div>
    );
  }

  if (user && !user.isGuest) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-16 text-center text-white/55 md:px-6">
        Redirecting…
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 md:px-6 md:py-14">
      <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-12 lg:gap-12">
        <Reveal as="div" delay={0} className="lg:col-span-5">
          <p className="font-display text-xs uppercase tracking-[0.2em] text-zooa-lime/80">{BRAND.name}</p>
          <h1 className="mt-3 font-display text-3xl tracking-wide text-[#c4f07a] md:text-4xl">Create account</h1>
          <p className="font-body mt-4 max-w-[52ch] text-base leading-relaxed text-white/65">
            Pick a nickname, secure password, and a real email. Your raider name is yours across raids.
          </p>
          <Link
            href="/auth/login"
            className="mt-8 inline-flex text-sm font-medium text-zooa-lime/90 underline-offset-4 transition hover:text-zooa-lime hover:underline"
          >
            Already have an account? Sign in
          </Link>
        </Reveal>

        <Reveal as="div" delay={100} className="lg:col-span-7">
          <form onSubmit={submit} className={`${glass} space-y-4`}>
            <label className="flex flex-col gap-2">
              <span className={authLabelClass}>Email</span>
              <input
                autoComplete="email"
                className={authInputClass}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className={authLabelClass}>Nickname</span>
              <input
                className={authInputClass}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="2–16 characters: letters, numbers, _"
                minLength={2}
                maxLength={16}
                required
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className={authLabelClass}>Password</span>
              <input
                autoComplete="new-password"
                className={authInputClass}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </label>

            <p className="font-body text-xs text-white/50">Password must be at least 8 characters.</p>

            {error && (
              <p className="font-body text-sm font-semibold text-rose-300/90" role="alert">
                {error}
              </p>
            )}

            <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
              <Link
                href="/"
                className="order-2 text-center text-sm text-white/45 transition hover:text-white/70 sm:order-1 sm:text-left"
              >
                Back to home
              </Link>
              <button
                type="submit"
                disabled={busy}
                className="order-1 font-display inline-flex min-h-12 w-full min-w-[12rem] items-center justify-center rounded-full bg-zooa-lime px-8 text-base tracking-wide text-zinc-950 transition hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 sm:order-2 sm:w-auto"
              >
                {busy ? "Creating…" : "Create account"}
              </button>
            </div>
          </form>
        </Reveal>
      </div>
    </div>
  );
}
