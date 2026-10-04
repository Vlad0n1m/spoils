import { z } from "zod";

/** An empty variable (`FOO=` copied from .env.example) counts as unset. */
const emptyAsUnset = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** Minimum CRON_SECRET length in production (Vercel generates longer ones; `openssl rand -hex 32` gives 64). */
export const CRON_SECRET_MIN_PROD = 16;

/** Required for app + sessions + settle. Solana custody secrets optional (guest / local play). */
const coreEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SOLANA_RPC_URL: z.preprocess(emptyAsUnset, z.string().url().default("https://api.devnet.solana.com")),
  SOLANA_CLUSTER: z.preprocess(
    emptyAsUnset,
    z.enum(["mainnet-beta", "devnet", "testnet"]).default("devnet"),
  ),
  SESSION_SECRET: z
    .string()
    .min(1)
    .transform((s) => {
      const t = s.trim();
      return t.length >= 32 ? t : t.padEnd(32, "x");
    }),
  GAME_SERVER_HMAC_SECRET: z.string().min(16),
  CRON_SECRET: z.preprocess(emptyAsUnset, z.string().min(8).optional()),
});

export type CoreEnv = z.infer<typeof coreEnvSchema>;

type EnvSource = Record<string, string | undefined>;

/** Production server runtime (not `next build`, which also runs with NODE_ENV=production). */
export function isProductionRuntime(env: EnvSource = process.env): boolean {
  return env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build";
}

/**
 * Production-only requirements on top of the schema. CRON_SECRET guards /api/cron/**: without it
 * anyone could trigger the void sweep and the daily economy step, so production refuses to run.
 * Dev keeps working without it (the cron routes are then open). Mirrored for the Docker boot check
 * in deploy/web-preflight.mjs: keep the two in sync.
 */
export function productionEnvProblems(env: EnvSource = process.env): string[] {
  if (!isProductionRuntime(env)) return [];
  const problems: string[] = [];
  const cron = env.CRON_SECRET?.trim() ?? "";
  if (!cron) problems.push("CRON_SECRET is required in production (Bearer token of /api/cron/**)");
  else if (cron.length < CRON_SECRET_MIN_PROD) {
    problems.push(`CRON_SECRET must be at least ${CRON_SECRET_MIN_PROD} characters in production`);
  }
  return problems;
}

/** Parses and checks an env source; throws with every problem listed (names only, never values). */
export function parseCoreEnv(env: EnvSource = process.env): CoreEnv {
  const parsed = coreEnvSchema.safeParse(env);
  const problems = productionEnvProblems(env);
  if (!parsed.success || problems.length > 0) {
    if (!parsed.success) console.error("Invalid env:", parsed.error.flatten().fieldErrors);
    for (const p of problems) console.error("Invalid env:", p);
    throw new Error("Invalid server env");
  }
  return parsed.data;
}

let cachedCore: CoreEnv | undefined;

/** DB + session + RPC + HMAC (+ CRON_SECRET in production). Does NOT require HOT_WALLET / MASTER_SEED. */
export function coreEnv(): CoreEnv {
  if (cachedCore) return cachedCore;
  cachedCore = parseCoreEnv(process.env);
  return cachedCore;
}

/** @deprecated use coreEnv — same */
export const serverEnv = coreEnv;

/** Length-independent string compare (no early exit on the first differing character). */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/**
 * Auth of the /api/cron/** routes: `Authorization: Bearer <CRON_SECRET>` (what Vercel Cron and the
 * compose scheduler deploy/cron/scheduler.mjs send). Without a secret the routes are open only
 * outside production; in production coreEnv() already refuses to parse without one.
 */
export function isCronAuthorized(
  authorization: string | null,
  cronSecret: string | undefined,
  env: EnvSource = process.env,
): boolean {
  if (!cronSecret) return !isProductionRuntime(env);
  return constantTimeEqual(authorization ?? "", `Bearer ${cronSecret}`);
}

/** Client-safe NEXT_PUBLIC_* (inlined at build). Used by Colyseus client. */
export const publicEnv = {
  gameServerUrl:
    process.env.NEXT_PUBLIC_GAME_SERVER_URL || "ws://localhost:2567",
} as const;
