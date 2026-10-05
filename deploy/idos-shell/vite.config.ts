import { defineConfig } from "vite";

// A relative base works on https://<titleid>.idos.games and its DEV copy alike (the iDos skill
// idosgames-getting-started: `vite build --base=<asset_base>` or "./"). The edition's address is
// baked at build: VITE_SPOILS_EDITION_URL=https://idos.<domain>/play npm run build
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
