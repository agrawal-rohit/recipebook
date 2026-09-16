import type { ConditionHandler, HandlerRuntime } from "@cheetos/core";

/**
 * Extract email from package.json author or bugs field.
 * @param ctx - Handler runtime.
 * @returns Inferred email or undefined.
 */
async function emailFromPackageJson(
	ctx: HandlerRuntime,
): Promise<string | undefined> {
	if (!(await ctx.isFile("package.json"))) return undefined;
	try {
		const pkg = JSON.parse(await ctx.readFile("package.json")) as {
			author?: string | { email?: string };
			bugs?: string | { email?: string; url?: string };
		};
		if (typeof pkg.author === "object" && pkg.author?.email) {
			return pkg.author.email;
		}
		if (typeof pkg.author === "string") {
			const emailMatch = /<([^>]+)>/.exec(pkg.author);
			if (emailMatch) return emailMatch[1];
		}
		if (typeof pkg.bugs === "object" && pkg.bugs?.email) {
			return pkg.bugs.email;
		}
	} catch {
		// Ignore JSON parse errors
	}
	return undefined;
}

/**
 * Suggest an enforcement contact email from `git config user.email` or `package.json`.
 * @param ctx - Condition handler context.
 * @returns Inferred email address, or undefined.
 */
const handler: ConditionHandler = {
	async infer(ctx) {
		try {
			const email = (await ctx.run("git config --get user.email")).trim();
			if (email.length > 0) return email;
		} catch {
			// Fall through to package.json check
		}
		return emailFromPackageJson(ctx);
	},
};

export default handler;
