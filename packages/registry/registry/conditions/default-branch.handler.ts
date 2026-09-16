import type { ConditionHandler } from "@pebbles/core";

/** Suggest a default branch from `git symbolic-ref`, falling back to `main`. */
const handler: ConditionHandler = {
	async infer(ctx) {
		try {
			const value = (
				await ctx.run("git symbolic-ref --short refs/remotes/origin/HEAD")
			)
				.trim()
				.replace(/^origin\//, "");
			if (value.length > 0) return value;
		} catch {
			// Fall through to local HEAD or main.
		}

		try {
			const value = (await ctx.run("git rev-parse --abbrev-ref HEAD")).trim();
			if (value.length > 0 && value !== "HEAD") return value;
		} catch {
			return "main";
		}

		return "main";
	},
};

export default handler;
