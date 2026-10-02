import type { Metadata } from "next";
import { Luckiest_Guy, Press_Start_2P } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const luckiestGuy = Luckiest_Guy({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-luckiest-guy",
  display: "swap",
});

const pixel = Press_Start_2P({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-pixel",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ZOOA",
  description: "PvP battle royale — get paid for your skill",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${luckiestGuy.variable} ${pixel.variable}`}>
      <body className={`${luckiestGuy.className} min-h-screen bg-ink-900 text-white`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
