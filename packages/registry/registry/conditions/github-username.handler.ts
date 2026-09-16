import type { ConditionHandler } from "@pebbles/core";

/**
 * Suggest the authenticated GitHub username or organization from GitHub CLI.
 * @param ctx - Condition handler context.
 * @returns Inferred owner, or undefined when GitHub CLI is unavailable or unauthenticated.
 */
const handler: ConditionHandler = {
	async infer(ctx) {
		try {
			const username = (await ctx.run("gh api user --jq .login")).trim();
			return username.length > 0 ? username : undefined;
		} catch {
			return undefined;
		}
	},
};

export default handler;
