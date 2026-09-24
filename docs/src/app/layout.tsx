import "@fontsource/encode-sans/400.css";
import "@fontsource/encode-sans/500.css";
import "@fontsource/encode-sans/600.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata, Viewport } from "next";
import "./global.css";

export const metadata: Metadata = {
  title: {
    default: "Yoinker | Declarative registries for anything you share",
    template: "%s | Yoinker",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAFAFA" },
    { media: "(prefers-color-scheme: dark)", color: "#0C0C0D" },
  ],
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="font-sans" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col" suppressHydrationWarning>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
