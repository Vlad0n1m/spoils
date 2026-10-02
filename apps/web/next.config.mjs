import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
// Next.js only auto-loads apps/web/.env — load monorepo root .env so one file at repo root works
loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, ".env.local"), override: true });
loadEnv({ path: path.join(here, ".env"), override: true });
loadEnv({ path: path.join(here, ".env.local"), override: true });

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  /** Trace workspace deps into `.next/standalone` (required for Docker / monorepo). */
  outputFileTracingRoot: path.join(here, "../.."),
  reactStrictMode: true,
  /** pixi.js v8 uses async sub-chunks; transpiling avoids flaky dev chunk loads (pnpm/Next HMR). */
  transpilePackages: ["@extract/shared", "pixi.js"],
  experimental: {
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },
};

export default nextConfig;
