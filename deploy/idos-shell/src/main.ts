/**
 * SPOILS iDos Games edition shell (docs/IDOS_EDITION.md §3.2–3.3). iDos hosts this static page at
 * https://<titleid>.idos.games. It:
 *   1. signs the player in with @idosgames/core: the iDos Games account (SSO from idosgames.com, the
 *      returned one-time code in the URL fragment), a remembered session (autoLogin, refresh token),
 *      or a guest account;
 *   2. shows the edition (our Next.js app + game server, VITE_SPOILS_EDITION_URL) in a full-screen
 *      iframe;
 *   3. answers the edition's hello (postMessage, exact origin both ways) with the player's iDos
 *      UserID and session ticket. The edition's server checks them with iDos before it signs anyone
 *      in (apps/web/src/lib/idos/verify.ts). Nothing goes into a URL.
 * The SDK calls follow the iDos skills "authentication" and "idosgames-getting-started" (core 0.21.1).
 */
import { beginSsoRedirect, createIDosGamesClient, readSsoCodeFromUrl } from "@idosgames/core";
import { IDOS_TITLE_ID } from "./idos.title";
import { BRIDGE_VERSION, MSG_HELLO, MSG_SESSION } from "./protocol";

const EDITION_URL: string = import.meta.env.VITE_SPOILS_EDITION_URL ?? "";

/** {titleid}.idos.games → "TITLEID", {titleid}-dev.idos.games → "TITLEID-DEV" (iDos base config.ts). */
function resolveTitleId(): string {
  if (IDOS_TITLE_ID) return IDOS_TITLE_ID;
  const m = window.location.hostname.toLowerCase().match(/^([a-z0-9]{8})(-dev)?\.idos\.games$/);
  if (!m) return "";
  return `${m[1]!.toUpperCase()}${m[2] ? "-DEV" : ""}`;
}

/** The SDK's own storage keys for a remembered login (@idosgames/core 0.21.1). */
function hasSavedSession(titleID: string): boolean {
  try {
    return !!localStorage.getItem(`Saved_AuthType_${titleID}`) || !!localStorage.getItem(`Saved_Auth_RefreshToken_${titleID}`);
  } catch {
    return false;
  }
}

const app = document.getElementById("app")!;

function card(title: string, text: string): HTMLDivElement {
  app.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "card";
  const inner = document.createElement("div");
  const h = document.createElement("h1");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  inner.append(h, p);
  wrap.append(inner);
  app.append(wrap);
  return inner;
}

function fail(text: string): void {
  card("SPOILS", text);
}

async function main(): Promise<void> {
  const titleID = resolveTitleId();
  if (!titleID) return fail("This page only runs on its iDos Games address.");
  let edition: URL;
  try {
    edition = new URL(EDITION_URL);
    if (edition.protocol !== "https:" && edition.hostname !== "localhost") throw new Error("not https");
  } catch {
    return fail("The game address is not set in this build.");
  }

  const client = createIDosGamesClient({ titleID, throttleMs: 0 });

  const play = (): void => {
    const auth = client.auth.context;
    if (!auth) return fail("Sign-in did not finish. Reload the page.");
    app.replaceChildren();
    const frame = document.createElement("iframe");
    frame.src = edition.toString();
    frame.title = "SPOILS";
    frame.allow = "fullscreen; autoplay; gamepad; clipboard-write";
    app.append(frame);
    window.addEventListener("message", (e: MessageEvent) => {
      if (e.origin !== edition.origin || e.source !== frame.contentWindow) return;
      const d = e.data as { type?: unknown; v?: unknown } | null;
      if (!d || d.type !== MSG_HELLO || d.v !== BRIDGE_VERSION) return;
      const now = client.auth.context;
      if (!now) return;
      frame.contentWindow?.postMessage(
        { type: MSG_SESSION, v: BRIDGE_VERSION, titleId: titleID, userId: now.userID, ticket: now.clientSessionTicket },
        edition.origin,
      );
    });
  };

  // 1. Back from idosgames.com with a one-time SSO code in the fragment (the SDK reads and clears it).
  const sso = readSsoCodeFromUrl();
  if (sso) {
    const r = await client.auth.loginWithSsoCode(sso.code);
    if (r.ok) return play();
  }
  // 2. A remembered session (refresh token, or a replayable guest / email login). Only when one was
  // saved: on a first visit autoLogin() replays the default method, Device, and silently makes a
  // guest, so the player would never see the choice below (checked on 8YECHSD4-DEV, 05.10).
  if (hasSavedSession(titleID)) {
    const resumed = await client.auth.autoLogin();
    if (resumed.ok) return play();
  }

  // 3. Ask.
  const inner = card("SPOILS", "Top-down extraction shooter. Sign in to keep your raider, stash and rank.");
  const err = document.createElement("p");
  err.className = "error";
  const idos = document.createElement("button");
  idos.className = "primary";
  idos.textContent = "Continue with iDos Games";
  idos.onclick = () => beginSsoRedirect({ titleID });
  const guest = document.createElement("button");
  guest.className = "ghost";
  guest.textContent = "Play as guest";
  guest.onclick = async () => {
    guest.disabled = true;
    const r = await client.auth.loginWithDeviceID();
    if (r.ok) return play();
    guest.disabled = false;
    err.textContent = "Guest sign-in failed. Try again.";
  };
  inner.append(idos, guest, err);
}

void main();
