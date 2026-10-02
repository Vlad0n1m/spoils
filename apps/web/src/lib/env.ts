import { z } from "zod";

/** Required for app + sessions + settle. Solana custody secrets optional (guest / local play). */
const coreEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SOLANA_RPC_URL: z.string().url(),
  SOLANA_CLUSTER: z
    .enum(["mainnet-beta", "devnet", "testnet"])
    .default("devnet"),
  SESSION_SECRET: z
    .string()
    .min(1)
    .transform((s) => {
      const t = s.trim();
      return t.length >= 32 ? t : t.padEnd(32, "x");
    }),
  GAME_SERVER_HMAC_SECRET: z.string().min(16),
  CRON_SECRET: z.string().min(8).optional(),
});

export type CoreEnv = z.infer<typeof coreEnvSchema>;

let cachedCore: CoreEnv | undefined;

/** DB + session + RPC + HMAC. Does NOT require HOT_WALLET / MASTER_SEED. */
export function coreEnv(): CoreEnv {
  if (cachedCore) return cachedCore;
  const parsed = coreEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid env:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid server env");
  }
  cachedCore = parsed.data;
  return cachedCore;
}

/** @deprecated use coreEnv — same */
export const serverEnv = coreEnv;

/** Client-safe NEXT_PUBLIC_* (inlined at build). Used by Colyseus client. */
export const publicEnv = {
  gameServerUrl:
    process.env.NEXT_PUBLIC_GAME_SERVER_URL ?? "ws://localhost:2567",
} as const;
