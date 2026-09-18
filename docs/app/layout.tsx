import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { DM_Sans, IBM_Plex_Mono, Newsreader } from "next/font/google";
import { siteUrl } from "@/lib/shared";
import "./global.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-cheetos-sans",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-cheetos-display",
});

const plexMono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-cheetos-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Cheetos",
    template: "%s | Cheetos",
  },
  description:
    "Compose project tooling from a registry — packs, scripts, and agent instructions.",
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${newsreader.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <body
        className="flex flex-col min-h-screen font-sans"
        suppressHydrationWarning
      >
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
