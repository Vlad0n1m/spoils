import type { Metadata, Viewport } from "next";
import { Luckiest_Guy, Nunito, Press_Start_2P } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { IdosBridge } from "@/components/idos/idos-bridge";
import { BRAND } from "@/lib/brand";
import { IDOS_BUILD } from "@/lib/edition";
import { SITE_URL } from "@/lib/site-url";

const luckiestGuy = Luckiest_Guy({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-luckiest-guy",
  display: "swap",
});

/**
 * Readable body font for paragraphs and long copy (Luckiest Guy is caps-only and tiring past a
 * line). next/font self-hosts it at build time, so there is no runtime request to Google.
 */
const nunito = Nunito({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const pixel = Press_Start_2P({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-pixel",
  display: "swap",
});

export const metadata: Metadata = {
  title: BRAND.fullName,
  description: "Top-down extraction shooter — drop in, loot up, get out alive",
  // Installable fullscreen landscape app (the Android TWA build packs this manifest).
  manifest: "/manifest.webmanifest",
  // Absolute og:url / og:image only when NEXT_PUBLIC_SITE_URL names the public origin (lib/site-url.ts).
  ...(SITE_URL ? { metadataBase: SITE_URL } : {}),
};

/** Phones: no pinch / double-tap zoom (no tap delay on the touch controls), content under the notch. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#08070B",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${luckiestGuy.variable} ${nunito.variable} ${pixel.variable}`}>
      <body className={`${luckiestGuy.className} min-h-screen bg-ink-900 text-white`}>
        <Providers>{children}</Providers>
        {/* iDos Games edition only: sign-in from the iDos shell around the iframe. */}
        {IDOS_BUILD && <IdosBridge />}
      </body>
    </html>
  );
}
