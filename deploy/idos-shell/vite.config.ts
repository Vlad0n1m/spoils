import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import webTailwind from "../../apps/web/tailwind.config";

/**
 * SPOILS iDos Games edition client (docs/IDOS_EDITION.md §3.2): the game's own lobby and PixiJS
 * client from apps/web, built as a static bundle that iDos hosts on the Title subdomain
 * (https://<titleid>.idos.games; the test copy under /v/<build>/). The backend stays on our server:
 * the API at VITE_SPOILS_API_URL (https://idos.<domain>) and the game server at
 * VITE_SPOILS_GAME_SERVER_URL (wss://game-idos.<domain>).
 *
 *   VITE_SPOILS_API_URL=https://idos.spoils.gg VITE_SPOILS_GAME_SERVER_URL=wss://game-idos.spoils.gg \
 *   VITE_IDOS_TITLE_IDS="8YECHSD4 8YECHSD4-DEV" npm run build
 *
 * Not part of the pnpm workspace (own npm, own lockfile); React, Pixi, Colyseus and @extract/shared
 * resolve from apps/web/node_modules, so run `pnpm install` at the repo root first.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../../apps/web");
const webSrc = path.join(web, "src");
const webRequire = createRequire(path.join(web, "package.json"));

const env = (k: string) => process.env[k]?.trim() ?? "";
const apiUrl = env("VITE_SPOILS_API_URL");
const gameServerUrl = env("VITE_SPOILS_GAME_SERVER_URL");
const titleIds = env("VITE_IDOS_TITLE_IDS").split(/\s+/).filter(Boolean);

/**
 * process.env of the web app's client code: what next.config inlines for the edition
 * (lib/edition-frame.mjs editionPublicEnv) plus the public game server URL. Anything else reads as unset.
 */
const clientEnv: Record<string, string> = {
  NODE_ENV: "production",
  NEXT_PUBLIC_IDOS_BUILD: "1",
  NEXT_PUBLIC_IDOS_SHELL_ORIGINS: titleIds.map((t) => `https://${t.toLowerCase()}.idos.games`).join(" "),
  NEXT_PUBLIC_GAME_SERVER_URL: gameServerUrl,
  NEXT_PUBLIC_SITE_URL: apiUrl,
};

/**
 * The app addresses its public files absolutely ("/sprites/x.png"); the iDos test copy is served
 * under /v/<build>/, so they become document-relative ("./sprites/x.png"), which also works at the
 * live root. Only string literals that start a known public folder are touched.
 */
function relativePublicPaths(): Plugin {
  const re = /(["'`])\/(sprites|lobby|sfx|landing)\//g;
  return {
    name: "spoils-relative-public-paths",
    enforce: "pre",
    transform(code, id) {
      if (!id.startsWith(webSrc) || !/\.(tsx?|jsx?|mjs)$/.test(id.split("?")[0]!)) return null;
      if (!re.test(code)) return null;
      re.lastIndex = 0;
      return { code: code.replace(re, "$1./$2/"), map: null };
    },
  };
}

export default defineConfig(({ command }) => {
  if (command === "build" && (!apiUrl || !gameServerUrl || titleIds.length === 0)) {
    throw new Error("Set VITE_SPOILS_API_URL, VITE_SPOILS_GAME_SERVER_URL and VITE_IDOS_TITLE_IDS (see vite.config.ts).");
  }
  return {
    base: "./",
    publicDir: path.join(web, "public"),
    resolve: {
      alias: [
        { find: /^@\//, replacement: `${webSrc}/` },
        { find: /^next\/link$/, replacement: path.join(here, "src/shims/next-link.tsx") },
        { find: /^next\/navigation$/, replacement: path.join(here, "src/shims/next-navigation.ts") },
        // One React for the shell and the app's components.
        { find: /^react$/, replacement: path.dirname(webRequire.resolve("react/package.json")) },
        { find: /^react\/(.*)$/, replacement: `${path.dirname(webRequire.resolve("react/package.json"))}/$1` },
        { find: /^react-dom$/, replacement: path.dirname(webRequire.resolve("react-dom/package.json")) },
        { find: /^react-dom\/(.*)$/, replacement: `${path.dirname(webRequire.resolve("react-dom/package.json"))}/$1` },
      ],
    },
    define: {
      "process.env": JSON.stringify(clientEnv),
      __SPOILS_API_URL__: JSON.stringify(apiUrl),
      __SPOILS_TITLE_IDS__: JSON.stringify(titleIds),
    },
    oxc: { jsx: { runtime: "automatic", importSource: "react" } },
    css: {
      postcss: {
        plugins: [
          webRequire("tailwindcss")({ ...webTailwind, content: [`${webSrc}/**/*.{js,ts,jsx,tsx,mdx}`] }),
          webRequire("autoprefixer"),
        ],
      },
    },
    plugins: [relativePublicPaths()],
    server: { fs: { allow: [here, web, path.resolve(here, "../../packages")] } },
    build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4096 },
  };
});
