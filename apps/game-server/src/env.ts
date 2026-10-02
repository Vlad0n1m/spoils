import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
// `here` = apps/game-server/src → monorepo root is three levels up
const repoRoot = path.resolve(here, "../../..");
// Monorepo root .env (same as apps/web + drizzle) — `tsx` does not auto-load it
loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, ".env.local") });
loadEnv({ path: path.join(here, ".env") });
loadEnv({ path: path.join(here, ".env.local") });
