import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { editionHeaders, editionPublicEnv, isIdosBuildEnv, parseFrameAncestors, wildcardSources } from "./src/lib/edition-frame.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
// Next.js only auto-loads apps/web/.env — load monorepo root .env so one file at repo root works
loadEnv({ path: path.join(repoRoot, ".env") });
loadEnv({ path: path.join(repoRoot, ".env.local"), override: true });
loadEnv({ path: path.join(here, ".env"), override: true });
loadEnv({ path: path.join(here, ".env.local"), override: true });

/**
 * iDos Games edition (IDOS_BUILD=1, docs/IDOS_EDITION.md): inlines NEXT_PUBLIC_IDOS_BUILD=1 and sends
 * CSP frame-ancestors (IDOS_FRAME_ANCESTORS or the iDos defaults). Off by default: the main build's
 * config gets neither `env` nor `headers`. Both are fixed at build time.
 */
const idosBuild = isIdosBuildEnv(process.env);
if (idosBuild) {
  const { sources, rejected, usedDefault } = parseFrameAncestors(process.env.IDOS_FRAME_ANCESTORS);
  if (rejected.length > 0) console.warn(`IDOS_FRAME_ANCESTORS: ignored ${rejected.length} invalid source(s): ${rejected.join(" ")}`);
  if (usedDefault && process.env.IDOS_FRAME_ANCESTORS?.trim()) console.warn("IDOS_FRAME_ANCESTORS: no valid source left, using the iDos defaults");
  const wild = wildcardSources(sources);
  if (wild.length > 0) console.warn(`IDOS_FRAME_ANCESTORS: ${wild.join(" ")} lets every site under it frame the signed-in edition; prefer the exact shell origin`);
}
const idosEdition = idosBuild
  ? {
      env: editionPublicEnv(process.env),
      async headers() {
        return editionHeaders(process.env);
      },
    }
  : {};

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
  ...idosEdition,
};

export default nextConfig;
