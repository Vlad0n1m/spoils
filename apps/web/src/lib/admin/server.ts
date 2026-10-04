import { cache } from "react";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { getSession } from "../session";
import { findAdmin, withAdmin } from "./guard";
import type { AdminUser } from "./types";

/**
 * The admin guard bound to the real session cookie and the app pool. Next renders a layout and its
 * page in parallel, so /admin/layout.tsx AND every /admin page call requireAdminPage() before they
 * read anything; cache() makes that one DB lookup per request.
 */
export const requireAdminPage = cache(async (): Promise<AdminUser> => {
  const admin = await findAdmin(db, await getSession()).catch((e) => {
    console.error("[admin] guard failed", e);
    return null;
  });
  if (!admin) notFound();
  return admin;
});

/** Route handler wrapper of /api/admin/**: 404 unless the caller is an admin. */
export function adminRoute(fn: (admin: AdminUser) => Promise<Response>): Promise<Response> {
  return withAdmin(getSession, db, fn);
}
