"use client";

import { useEffect } from "react";
import { IDOS_BUILD, IDOS_SHELL_ORIGINS, isFramed } from "@/lib/edition";
import { BRIDGE_VERSION, MSG_HELLO, parseShellMessage } from "@/lib/idos/bridge-protocol";

/**
 * iDos sign-in bridge, page side (docs/IDOS_EDITION.md §3.3). Mounted by the root layout in the
 * edition only. Inside the iDos shell's iframe it says hello to the shell, takes the player's iDos
 * session from the reply (only from window.parent at an allowed shell origin), and posts it to
 * /api/idos/session, which checks it with iDos. When that signs in a different account, the page
 * reloads once with the new session; when the session already is that account ("same"), nothing
 * happens. Opened directly (not framed) or built without IDOS_TITLE_IDS, it does nothing and the
 * usual sign-in stays.
 */
export function IdosBridge() {
  useEffect(() => {
    if (!IDOS_BUILD || IDOS_SHELL_ORIGINS.length === 0 || !isFramed()) return;
    let done = false;
    const onMessage = (e: MessageEvent) => {
      if (done || e.source !== window.parent || !IDOS_SHELL_ORIGINS.includes(e.origin)) return;
      const msg = parseShellMessage(e.data);
      if (!msg) return;
      done = true;
      window.removeEventListener("message", onMessage);
      void fetch("/api/idos/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(msg),
      })
        .then(async (r) => {
          const body = (await r.json().catch(() => null)) as { status?: string; error?: string } | null;
          if (r.ok && (body?.status === "created" || body?.status === "signed_in")) window.location.reload();
          else if (!r.ok) console.warn("[idos] sign-in bridge refused:", r.status, body?.error);
        })
        .catch(() => console.warn("[idos] sign-in bridge unreachable"));
    };
    window.addEventListener("message", onMessage);
    // A targetOrigin that is not the parent's origin is dropped by the browser, so only our shell hears it.
    for (const origin of IDOS_SHELL_ORIGINS) window.parent.postMessage({ type: MSG_HELLO, v: BRIDGE_VERSION }, origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return null;
}
