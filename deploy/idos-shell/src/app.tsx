/** The web app's lobby (apps/web components/menu/main-menu.tsx) mounted in the iDos page. */
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@/app/globals.css";
import "./fonts/fonts.css";
import { Providers } from "@/components/providers";
import { MainMenu } from "@/components/menu/main-menu";
import { parseLobbyPanel } from "@/lib/lobby/panels";

export function mountGame(root: HTMLElement): void {
  // What app/layout.tsx sets through next/font: the font variables and the body font.
  const html = document.documentElement;
  html.style.setProperty("--font-luckiest-guy", "'Luckiest Guy'");
  html.style.setProperty("--font-body", "'Nunito'");
  html.style.setProperty("--font-pixel", "'Press Start 2P'");
  document.body.className = "min-h-screen bg-ink-900 text-white";
  document.body.style.fontFamily = "'Luckiest Guy', Impact, system-ui, cursive";
  document.body.style.overflow = "";

  const initialPanel = parseLobbyPanel(Object.fromEntries(new URLSearchParams(window.location.search)));
  root.replaceChildren();
  root.removeAttribute("style");
  root.className = "";
  createRoot(root).render(
    <StrictMode>
      <Providers>
        <Suspense fallback={<div className="h-[100dvh] bg-[#090b08]" aria-busy="true" />}>
          <MainMenu initialPanel={initialPanel} />
        </Suspense>
      </Providers>
    </StrictMode>,
  );
}
