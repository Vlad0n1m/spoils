import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      // Main menu (Brawl Stars layout): `land` = the landscape layout (tablets and desktops, and any
      // phone held sideways), `port` = the stacked portrait-phone fallback, `short` / `tiny` = landscape
      // phones (≤ 500 / ≤ 380 px tall). Raw screens come after the width ones, so they win.
      screens: {
        land: { raw: "(min-width: 768px), (max-height: 500px)" },
        port: { raw: "(max-width: 767px) and (min-height: 501px)" },
        short: { raw: "(max-height: 500px)" },
        tiny: { raw: "(max-height: 380px)" },
      },
      keyframes: {
        "outcome-enter": {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        marquee: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-14px)" },
        },
        "float-sm": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" },
        },
        "glow-pulse": {
          "0%, 100%": {
            boxShadow:
              "0 0 0 8px rgba(204,255,0,0.08), 0 0 48px rgba(204,255,0,0.45), 0 16px 64px rgba(204,255,0,0.35)",
          },
          "50%": {
            boxShadow:
              "0 0 0 14px rgba(204,255,0,0.14), 0 0 80px rgba(204,255,0,0.7), 0 24px 96px rgba(204,255,0,0.55)",
          },
        },
        twinkle: {
          "0%, 100%": { opacity: "0.15" },
          "50%": { opacity: "0.32" },
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "text-breathe": {
          "0%, 100%": { textShadow: "0 0 18px rgba(212,160,23,0.35)", opacity: "0.9" },
          "50%": { textShadow: "0 0 36px rgba(212,160,23,0.6)", opacity: "1" },
        },
        // ---- WORLD v6 main menu (spec §6.7): transform / opacity / filter only.
        "hero-idle": {
          "0%, 100%": { transform: "translateY(0) scaleY(1)" },
          "50%": { transform: "translateY(-4px) scaleY(1.01)" },
        },
        "banner-drop": {
          "0%": { opacity: "0", transform: "translateY(-16px)" },
          "60%": { opacity: "1", transform: "translateY(2px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "shake-once": {
          "0%, 100%": { transform: "translateX(0)" },
          "20%": { transform: "translateX(-3px)" },
          "40%": { transform: "translateX(3px)" },
          "60%": { transform: "translateX(-2px)" },
          "80%": { transform: "translateX(2px)" },
        },
        "xp-fill": {
          "0%, 100%": { filter: "brightness(1)" },
          "50%": { filter: "brightness(1.7)" },
        },
        "drawer-in-left": {
          "0%": { opacity: "0", transform: "translateX(-24px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "drawer-in-right": {
          "0%": { opacity: "0", transform: "translateX(24px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "sheet-up": {
          "0%": { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "panel-in": {
          "0%": { opacity: "0", transform: "scale(0.98)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "pop-in": {
          "0%": { opacity: "0", transform: "scale(0.6)" },
          "70%": { opacity: "1", transform: "scale(1.06)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        stripes: {
          "0%": { backgroundPosition: "0 0" },
          "100%": { backgroundPosition: "28px 0" },
        },
        // Opacity-only glow (compositor): PLAY and the hero ring pulse without repainting shadows.
        "soft-glow": {
          "0%, 100%": { opacity: "0.35" },
          "50%": { opacity: "0.85" },
        },
      },
      animation: {
        "outcome-enter": "outcome-enter 0.55s ease-out both",
        marquee: "marquee 28s linear infinite",
        float: "float 6s ease-in-out infinite",
        "float-sm": "float-sm 4.5s ease-in-out infinite",
        "glow-pulse": "glow-pulse 3.2s ease-in-out infinite",
        twinkle: "twinkle 5s ease-in-out infinite",
        "fade-up": "fade-up 0.8s cubic-bezier(0.16,1,0.3,1) both",
        "text-breathe": "text-breathe 4s ease-in-out infinite",
        "hero-idle": "hero-idle 4s ease-in-out infinite",
        "banner-drop": "banner-drop 0.3s cubic-bezier(0.16,1,0.3,1) both",
        "shake-once": "shake-once 0.4s ease-in-out 0.3s 1",
        "xp-fill": "xp-fill 0.9s ease-out 1",
        "drawer-in-left": "drawer-in-left 0.22s cubic-bezier(0.16,1,0.3,1) both",
        "drawer-in-right": "drawer-in-right 0.22s cubic-bezier(0.16,1,0.3,1) both",
        "sheet-up": "sheet-up 0.22s cubic-bezier(0.16,1,0.3,1) both",
        "panel-in": "panel-in 0.18s cubic-bezier(0.16,1,0.3,1) both",
        "pop-in": "pop-in 0.45s cubic-bezier(0.16,1,0.3,1) both",
        stripes: "stripes 1.2s linear infinite",
        "soft-glow": "soft-glow 3.2s ease-in-out infinite",
      },
      colors: {
        ink: {
          900: "#08070b",
          800: "#0e0d14",
          700: "#16151f",
          600: "#1f1d2b",
          500: "#2a2839",
        },
        accent: {
          500: "#9945ff",
          400: "#b07bff",
          300: "#c8a3ff",
        },
        sol: {
          400: "#14f195",
          500: "#00d488",
        },
        zooa: {
          lime: "#CCFF00",
          dark: "#0a100c",
        },
      },
      fontFamily: {
        sans: [
          "var(--font-luckiest-guy)",
          "Luckiest Guy",
          "Impact",
          "system-ui",
          "cursive",
        ],
        display: [
          "var(--font-luckiest-guy)",
          "Luckiest Guy",
          "Impact",
          "system-ui",
          "cursive",
        ],
        pixel: [
          "var(--font-pixel)",
          "Press Start 2P",
          "ui-monospace",
          "monospace",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
