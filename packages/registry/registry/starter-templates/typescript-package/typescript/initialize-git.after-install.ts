import type { AfterInstallHook } from "@pebbles/core";

/**
 * Conditionally initialize a git repository in the consuming project after the starter template files are written.
 * @param ctx - Install hook context.
 */
const initializeGit: AfterInstallHook = async (ctx) => {
	// If the user has explicitly opted out, do nothing.
	if (ctx.conditions.initializeGit !== true) return;
	// If the project is already a git repository, do nothing.
	if (await ctx.isDirectory(".git")) return;

	// Initialize a git repository.
	try {
		await ctx.run("git init");
	} catch {
		// Non-fatal if git is missing or the directory is not initializable.
	}
};

export default initializeGit;
