import type { AfterInstallHook } from "@pebbles/core";

/**
 * Initialize Fallow setup by invoking the canonical Fallow CLI against the
 * live project: runs `fallow init` to create `.fallowrc.json` when missing,
 * then captures baseline snapshots (dead-code, health, dupes) so CI only
 * blocks on newly introduced debt. Avoids shipping hardcoded baseline files
 * that drift from Fallow's runtime format.
 * @param ctx - Install hook context.
 */
const initializeFallowSetup: AfterInstallHook = async (ctx) => {
	// 1. Ensure .fallowrc.json exists so the baseline commands have a config to read.
	if (!(await ctx.isFile(".fallowrc.json"))) {
		try {
			await ctx.run("npx --yes fallow init");
		} catch {
			// Continue even if init fails; baseline commands may still succeed with defaults.
		}
	}

	// 2. Snapshot current project state so CI only blocks on newly introduced debt.
	const baselines = [
		["dead-code", "fallow-baselines/dead-code.json"],
		["health", "fallow-baselines/health.json"],
		["dupes", "fallow-baselines/dupes.json"],
	] as const;

	for (const [command, file] of baselines) {
		try {
			await ctx.run(`npx --yes fallow ${command} --save-baseline ${file}`);
		} catch {
			// Non-fatal if project has syntax errors or fallow is offline.
		}
	}
};

export default initializeFallowSetup;