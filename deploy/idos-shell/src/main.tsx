/**
 * SPOILS iDos Games edition client (docs/IDOS_EDITION.md §3.2–3.3). iDos hosts this static page at
 * https://<titleid>.idos.games (the game must be hosted there, not framed from elsewhere). It:
 *   1. signs the player in with @idosgames/core: the iDos Games account (SSO from idosgames.com, the
 *      returned one-time code in the URL fragment), a remembered session (autoLogin, refresh token),
 *      or a guest account;
 *   2. trades the player's iDos UserID and session ticket for a session of our backend: POST
 *      /api/idos/session checks them with iDos (apps/web/src/lib/idos/verify.ts) and answers with a
 *      session token, which every API call then carries (api.ts);
 *   3. runs the game itself: the web app's lobby and PixiJS client, built into this bundle (app.tsx),
 *      talking to our API and game server.
 * The SDK calls follow the iDos skills "authentication" and "idosgames-getting-started" (core 0.21.1).
 */
import { beginSsoRedirect, createIDosGamesClient, readSsoCodeFromUrl, type IDosGamesClient } from "@idosgames/core";
import { API_URL, authorization, installApiFetch, loadToken, saveToken } from "./api";
import { IDOS_TITLE_ID } from "./idos.title";
import { installNavigation, playUrl } from "./nav";

declare const __SPOILS_TITLE_IDS__: string[];

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

function fail(text: string, retry = false): void {
  const inner = card("SPOILS", text);
  if (!retry) return;
  const b = document.createElement("button");
  b.className = "primary";
  b.textContent = "Try again";
  b.onclick = () => window.location.assign(playUrl());
  inner.append(b);
}

/** iDos player → our session token. True when the API accepted the player. */
async function signInToGame(client: IDosGamesClient, titleId: string): Promise<boolean> {
  const auth = client.auth.context;
  if (!auth) return false;
  const res = await fetch(`${API_URL}/api/idos/session`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json", Authorization: authorization() },
    body: JSON.stringify({ titleId, userId: auth.userID, ticket: auth.clientSessionTicket }),
  }).catch(() => null);
  if (!res) return false;
  const body = (await res.json().catch(() => null)) as { status?: string; token?: string; error?: string } | null;
  if (!res.ok) {
    console.warn("[idos] game sign-in refused:", res.status, body?.error);
    // A stale or foreign token: forget it, the next attempt starts a fresh session.
    if (res.status === 401) saveToken("");
    return false;
  }
  if (body?.token) saveToken(body.token);
  return body?.status === "same" || !!body?.token;
}

async function main(): Promise<void> {
  const titleID = resolveTitleId();
  if (!titleID) return fail("This page only runs on its iDos Games address.");
  if (!__SPOILS_TITLE_IDS__.includes(titleID)) return fail("This build is not set up for this iDos Games title.");
  installNavigation();
  installApiFetch();
  loadToken(titleID);

  const client = createIDosGamesClient({ titleID, throttleMs: 0 });

  const play = async (): Promise<void> => {
    card("SPOILS", "Loading…");
    if (!(await signInToGame(client, titleID))) {
      // One retry with a fresh token session (an expired token was just dropped).
      if (!(await signInToGame(client, titleID))) return fail("Could not reach the game server. Check your connection.", true);
    }
    // For the lobby's "back to the menu" reloads (apps/web lib/play-url.ts).
    (window as { __SPOILS_PLAY_URL__?: string }).__SPOILS_PLAY_URL__ = playUrl();
    const { mountGame } = await import("./app");
    mountGame(app);
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
