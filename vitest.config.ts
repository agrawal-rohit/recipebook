import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		globals: true,
		exclude: [
			...configDefaults.exclude,
			"packages/*/dist/**",
			"**/.stryker-tmp/**",
			"docs/**",
		],
		coverage: {
			reporter: ["text", "lcov", "html"],
			exclude: [
				...(configDefaults.coverage.exclude || []),
				"docs/**",
				"**/coverage/**",
				"packages/*/dist/**",
				"packages/cli/bin/**",
				"**/commitlint.config.*",
				"**/lint-staged.config.js",
				"**/stryker.config.mjs",
			],
		},
	},
});