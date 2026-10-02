import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
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
