import type { ConditionHandler } from "@pebbles/core";

/** Suggest an author name default from `git config user.name`. */
const handler: ConditionHandler = {
	async infer(ctx) {
		try {
			const value = (await ctx.run("git config --get user.name")).trim();
			return value.length > 0 ? value : undefined;
		} catch {
			return undefined;
		}
	},
};

export default handler;
