/**
 * @filename: lint-staged.config.js
 * @type {import('lint-staged').Configuration}
 */

/** Rebuild compiled artefacts and stage `registry.json`. */
function rebuildRegistryCommands() {
	return [
		"pnpm run build:registry",
		"git add packages/registry/registry.json",
	];
}

export default {
	// Only run Biome on code/config files that Biome actually processes (see biome.json).
	"packages/**/*.{js,ts,jsx,tsx,cjs,mjs,json,css}": "pnpm check",
	"docs/**/*.{js,ts,jsx,tsx,mjs,json,css}":
		"pnpm exec biome check --write --no-errors-on-unmatched",
	"{packages/registry/registry/**/*,packages/registry/scripts/build-registry.ts,packages/core/src/build.ts,packages/core/src/schema.ts,packages/core/src/parse.ts}":
		() => rebuildRegistryCommands(),
};
