import type { ConditionHandler } from "@pebbles/core";

/**
 * Suggest SonarQube project key by parsing remote.origin.url formatted as org_repo.
 * @param ctx - Condition handler context.
 * @returns Inferred project key, or undefined.
 */
const handler: ConditionHandler = {
	async infer(ctx) {
		try {
			const remoteUrl = (await ctx.run("git config --get remote.origin.url")).trim();
			const match = /(?:[:/])([^/:]+)\/([^/:]+?)(?:\.git)?$/.exec(remoteUrl);
			if (match) return `${match[1]}_${match[2]}`;
		} catch {
			// Fall back to package.json name if available
		}

		if (await ctx.isFile("package.json")) {
			try {
				const pkg = JSON.parse(await ctx.readFile("package.json")) as {
					name?: string;
				};
				if (typeof pkg.name === "string" && pkg.name.trim().length > 0) {
					// Normalize @scope/name to scope_name
					return pkg.name.trim().replace(/^@/, "").replace("/", "_");
				}
			} catch {
				// Ignore parse errors
			}
		}

		return undefined;
	},
};

export default handler;
