import type { Metadata } from "next";
import { Luckiest_Guy, Nunito, Press_Start_2P } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

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
  title: "EXTRACT",
  description: "Top-down extraction shooter — drop in, loot up, get out alive",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${luckiestGuy.variable} ${nunito.variable} ${pixel.variable}`}>
      <body className={`${luckiestGuy.className} min-h-screen bg-ink-900 text-white`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
