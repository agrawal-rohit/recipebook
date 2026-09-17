import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		globals: true,
		exclude: [
			...configDefaults.exclude,
			"**/dist/**",
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
				"**/dist/**",
			],
		},
	},
});
