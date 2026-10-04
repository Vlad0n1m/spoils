"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 44 px square copy button for a wallet address, with a 1.5 s "copied" tick. */
export function CopyAddressButton({ address, className }: { address: string; className?: string }) {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onCopy = async () => {
    const ok = await copyText(address);
    setCopied(ok ? "ok" : "fail");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied("idle"), 1500);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void onCopy()}
        aria-label="Copy wallet address"
        title={copied === "ok" ? "Copied" : "Copy address"}
        className={clsx(
          "grid h-11 w-11 shrink-0 place-items-center rounded-xl border-2 border-white/15 bg-white/5 text-white/80 transition hover:border-zooa-lime/50 hover:text-white active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime motion-reduce:transition-none",
          copied === "ok" && "border-zooa-lime/60 text-zooa-lime",
          className,
        )}
      >
        {copied === "ok" ? (
          <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
            <path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
            <rect x="7" y="7" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M13 4.5V4a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 3 4v7a1.5 1.5 0 0 0 1.5 1.5H5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied === "ok" ? "Address copied" : copied === "fail" ? "Couldn't copy the address" : ""}
      </span>
    </>
  );
}
