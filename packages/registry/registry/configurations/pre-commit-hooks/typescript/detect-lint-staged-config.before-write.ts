import type { BeforeWriteHook } from "@cheetos/core";

/**
 * Detect the lint-staged config based on the project's formatter/linter tooling.
 * @param ctx - Install hook context.
 * @returns Updated file for lint-staged.config.js.
 */
const beforeWrite: BeforeWriteHook = async (ctx) => {
	const hasBiome = (await ctx.isFile("biome.json")) || (await ctx.isFile("biome.jsonc"));
	let command = "{{pmExec}} biome check .";

	if (!hasBiome && (await ctx.isFile("package.json"))) {
		try {
			const pkg = JSON.parse(await ctx.readFile("package.json")) as {
				devDependencies?: Record<string, string>;
				dependencies?: Record<string, string>;
			};
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };
			if (deps.eslint && deps.prettier) {
				command = "{{pmExec}} eslint --fix && {{pmExec}} prettier --write";
			} else if (deps.eslint) {
				command = "{{pmExec}} eslint --fix";
			} else if (deps.prettier) {
				command = "{{pmExec}} prettier --write";
			}
		} catch {
			// Fallback to default
		}
	}

	const content = `/**
 * @filename: lint-staged.config.js
 * @type {import('lint-staged').Configuration}
 */
export default {
	"src/**/*.{js,ts,jsx,tsx,cjs,mjs,json,css}": "${command}",
};
`;

	return {
		files: [
			{
				target: "lint-staged.config.js",
				content,
			},
		],
	};
};

export default beforeWrite;
