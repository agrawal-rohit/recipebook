import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Match Jest's node environment
		environment: "node",
		// Enable Jest-style global APIs (describe, test, expect) without imports
		globals: true,
		// Preserve Vitest's default excludes (already includes node_modules, etc.)
		exclude: [
			...configDefaults.exclude,
			"packages/*/dist/**",
			"**/.stryker-tmp/**",
		],
		coverage: {
			reporter: ["text", "lcov", "html"],
			thresholds: {
				lines: 80,
				statements: 80,
				functions: 80,
				branches: 80,
			},
			exclude: [
				...(configDefaults.coverage.exclude || []),
				"**/coverage/**",
				"packages/*/dist/**",
				"**/commitlint.config.*",
				"**/lint-staged.config.js",
				"packages/cli/bin/**",
				"**/stryker.config.mjs",
			],
		},
	},
});