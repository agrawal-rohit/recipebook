/**
 * @filename: lint-staged.config.js
 * @type {import('lint-staged').Configuration}
*/
export default {
	"packages/**/*.{js,ts,jsx,tsx,cjs,mjs,json,css}": "pnpm check",
	"docs/**/*.{js,ts,jsx,tsx,mjs,json,css}":
		"pnpm exec biome check --write --no-errors-on-unmatched",
};