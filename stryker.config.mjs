// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	packageManager: "pnpm",
	reporters: ["html", "json", "clear-text", "progress"],
	testRunner: "vitest",
	testRunner_comment:
		"Take a look at https://stryker-mutator.io/docs/stryker-js/vitest-runner for information about the vitest plugin.",
	coverageAnalysis: "perTest",
	plugins: [
		"@stryker-mutator/vitest-runner",
		"@stryker-mutator/typescript-checker",
	],
	checkers: ["typescript"],
	tsconfigFile: "tsconfig.json",
	typescriptChecker: {
		prioritizePerformanceOverAccuracy: true,
	},
	mutate: [
		"packages/*/src/**/*.ts",
		"!packages/*/src/**/*.test.ts",
		"!packages/*/src/**/*.spec.ts",
	],
	ignorePatterns: [
		"coverage",
		"**/*.md",
	],
	incremental: true,
	vitest: {
		configFile: "vitest.config.ts",
		related: true,
	},
};
export default config;
