import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import "./global.css";
import { Inter } from "next/font/google";

export const metadata: Metadata = {
	title: {
		template: "%s | Pebbles",
		default: "Pebbles",
	},
	description: "An opinionated scaffolding CLI for modern developers.",
};

const inter = Inter({
	subsets: ["latin"],
});

export default function Layout({ children }: LayoutProps<"/">) {
	return (
		<html lang="en" className={inter.className} suppressHydrationWarning>
			<body className="flex flex-col min-h-screen" suppressHydrationWarning>
				<RootProvider>{children}</RootProvider>
			</body>
		</html>
	);
}
