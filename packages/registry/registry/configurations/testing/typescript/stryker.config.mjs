// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
	packageManager: "{{packageManager}}",
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
		"src/**/*.{ts,tsx}",
		"!src/**/*.{test,spec}.{ts,tsx}",
	],
	ignorePatterns: [
		"coverage",
		"dist",
		"build",
		"out",
		"**/*.md",
	],
	incremental: true,
	thresholds: {
		high: 80,
		low: 60,
		break: 70,
	},
	vitest: {
		configFile: "vitest.config.ts",
		related: true,
	},
};
export default config;
