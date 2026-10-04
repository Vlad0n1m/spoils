// Boot check of the web container (apps/web/Dockerfile runs it before `node apps/web/server.js`).
// Mirrors productionEnvProblems + the core schema of apps/web/src/lib/env.ts: keep them in sync.
// Prints variable names only, never values. Exit 1 makes the container refuse to start.
const env = process.env;
const production = env.NODE_ENV === "production";
const set = (k) => typeof env[k] === "string" && env[k].trim() !== "";
const problems = [];
const warnings = [];

if (!set("DATABASE_URL")) problems.push("DATABASE_URL is required");
if (!set("SESSION_SECRET")) problems.push("SESSION_SECRET is required");
else if (env.SESSION_SECRET.trim().length < 32) {
  // lib/session-secret.ts refuses it at runtime too: a short secret makes sessions forgeable.
  (production ? problems : warnings).push("SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)");
}
if ((env.GAME_SERVER_HMAC_SECRET ?? "").length < 16) {
  problems.push("GAME_SERVER_HMAC_SECRET (16+ characters, same as the game server) is required");
}
if (set("SOLANA_RPC_URL")) {
  try {
    new URL(env.SOLANA_RPC_URL);
  } catch {
    problems.push("SOLANA_RPC_URL is not a URL");
  }
}

if (production) {
  const cron = (env.CRON_SECRET ?? "").trim();
  if (!cron) problems.push("CRON_SECRET is required in production (Bearer token of /api/cron/**)");
  else if (cron.length < 16) problems.push("CRON_SECRET must be at least 16 characters in production");
  // keypair.ts throws on the first registration without it; say so at boot already.
  if (!/^[0-9a-fA-F]{64,}$/.test((env.MASTER_SEED_HEX ?? "").trim())) {
    warnings.push("MASTER_SEED_HEX (64+ hex chars) is missing or malformed: wallet registration will fail");
  }
  // lib/wallet-dev-topup-server.ts: the dev top-up mints balance. Production allows it only on purpose
  // (a demo stack: WALLET_DEV_TOPUP_PRODUCTION=1) and never on mainnet.
  const flagOn = (v) => v === "1" || (v ?? "").toLowerCase() === "true";
  if (flagOn(env.NEXT_PUBLIC_WALLET_DEV_TOPUP)) {
    const mainnet = (env.SOLANA_CLUSTER ?? "").trim() === "mainnet-beta" || (env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "").trim() === "mainnet-beta";
    if (!flagOn(env.WALLET_DEV_TOPUP_PRODUCTION)) {
      problems.push("NEXT_PUBLIC_WALLET_DEV_TOPUP is on in production: set it to 0 and rebuild (or WALLET_DEV_TOPUP_PRODUCTION=1 for a devnet demo)");
    } else if (mainnet) {
      problems.push("the dev top-up can never run on mainnet-beta: set NEXT_PUBLIC_WALLET_DEV_TOPUP=0 and rebuild");
    } else {
      warnings.push("dev top-up is ON (demo stack): every account can mint balance");
    }
  }
  // docker-compose.yml: an unset POSTGRES_PASSWORD falls back to "postgres".
  if (/^postgres(ql)?:\/\/postgres:postgres@/.test((env.DATABASE_URL ?? "").trim())) {
    warnings.push("DATABASE_URL uses the default password 'postgres': set POSTGRES_PASSWORD in .env");
  }
  // lib/wallet/request.ts: the Sign-In with Solana domain is pinned to these hosts; unset → localhost only.
  if (!set("SIWS_ALLOWED_HOSTS")) {
    warnings.push("SIWS_ALLOWED_HOSTS is unset: linking a Solana wallet only works on localhost (list the public host)");
  }
}

for (const w of warnings) console.warn(`[preflight] warning: ${w}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`[preflight] ${p}`);
  console.error("[preflight] the web refuses to start; fix .env and restart the container");
  process.exit(1);
}
console.log("[preflight] env ok");
