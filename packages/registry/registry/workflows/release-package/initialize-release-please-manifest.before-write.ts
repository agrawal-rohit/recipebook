import type { BeforeWriteHook } from "@cheetos/core";

/**
 * Initialize `.release-please-manifest.json` from the version currently in
 * `package.json`. Falls back to `0.0.1` when `package.json` is missing or
 * unversioned, so the manifest is always valid for a fresh project.
 * @param ctx - Install hook context.
 * @returns Updated `.release-please-manifest.json` file.
 */
const initializeReleasePleaseManifest: BeforeWriteHook = async (ctx) => {
	let version = "0.0.1";

	if (await ctx.isFile("package.json")) {
		try {
			const pkg = JSON.parse(await ctx.readFile("package.json")) as {
				version?: string;
			};
			if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
				version = pkg.version.trim();
			}
		} catch {
			// Fall back to default version
		}
	}

	return {
		files: [
			{
				target: ".release-please-manifest.json",
				content: `${JSON.stringify({ ".": version }, null, "\t")}\n`,
			},
		],
	};
};

export default initializeReleasePleaseManifest;