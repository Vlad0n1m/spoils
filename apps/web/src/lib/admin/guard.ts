import { sql } from "drizzle-orm";
import type { Db } from "../inventory/db";
import type { AdminUser } from "./types";

/**
 * Admin access: a signed-in registered user whose users.role is 'admin' (granted by hand with SQL,
 * README "Админка"). The role is read from the DB on every request, never cached in the session
 * cookie, so revoking it with SQL takes effect at once. Anyone else gets a plain 404 from /admin and
 * every /api/admin route, so the panel's existence is not advertised. Kept free of next/headers
 * so tests can call it with a fake session (lib/admin/server.ts binds it to the real one).
 */

/** The session fields the guard reads (lib/session.ts AppSession). */
export interface SessionLike {
  userId?: string;
  nickname?: string;
  guest?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The admin behind this session, or null (anonymous, guest, unknown user, no role). */
export async function findAdmin(db: Pick<Db, "execute">, s: SessionLike | null | undefined): Promise<AdminUser | null> {
  if (!s || s.guest || typeof s.userId !== "string" || !UUID_RE.test(s.userId)) return null;
  const r = await db.execute<{ id: string; nickname: string; role: string | null }>(
    sql`select id, nickname, role from users where id = ${s.userId}`,
  );
  const u = r.rows[0];
  return u && u.role === "admin" ? { id: u.id, nickname: u.nickname } : null;
}

/** The 404 every non-admin gets from /api/admin/** (no hint that the route exists). */
export function adminNotFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Runs `fn` for an admin, 404 for everyone else. Errors inside `fn` become a 500 without details
 * (logged server-side).
 */
export async function withAdmin(
  loadSession: () => Promise<SessionLike | null | undefined>,
  db: Pick<Db, "execute">,
  fn: (admin: AdminUser) => Promise<Response>,
): Promise<Response> {
  let admin: AdminUser | null = null;
  try {
    admin = await findAdmin(db, await loadSession());
  } catch (e) {
    console.error("[admin] guard failed", e);
    return adminNotFound();
  }
  if (!admin) return adminNotFound();
  try {
    return await fn(admin);
  } catch (e) {
    console.error("[admin] handler failed", e);
    return adminJson({ error: "failed", message: "Ошибка сервера, см. логи." }, 500);
  }
}

export function adminJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
