import type { ConditionHandler } from "@pebbles/core";

/**
 * Suggest SonarQube organization key by parsing remote.origin.url.
 * Supports SSH (git@github.com:org/repo.git) and HTTPS (https://github.com/org/repo.git).
 * @param ctx - Condition handler context.
 * @returns Inferred organization name, or undefined.
 */
const handler: ConditionHandler = {
	async infer(ctx) {
		try {
			const remoteUrl = (await ctx.run("git config --get remote.origin.url")).trim();
			const match = /(?:[:/])([^/:]+)\/([^/:]+?)(?:\.git)?$/.exec(remoteUrl);
			if (match) return match[1];
		} catch {
			// Remote origin might not exist
		}
		return undefined;
	},
};

export default handler;
