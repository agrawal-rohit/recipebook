import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Anchor root to this config's directory: Vite's default is process.cwd(),
// which is wrong when the app is served through a parent workspace.
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	plugins: [react(), tailwindcss()],
});
