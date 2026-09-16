import type { ConditionHandler } from "@pebbles/core";

/** Suggest a Node.js major version from `.nvmrc`, `.node-version`, or `package.json` engines. */
const handler: ConditionHandler = {
	async infer(ctx) {
		for (const file of [".nvmrc", ".node-version"]) {
			if (!(await ctx.isFile(file))) continue;
			try {
				const raw = (await ctx.readFile(file)).trim();
				const match = /\d+/.exec(raw);
				if (match) return match[0];
			} catch {
				// Try the next marker file.
			}
		}

		if (await ctx.isFile("package.json")) {
			try {
				const packageJson = JSON.parse(await ctx.readFile("package.json")) as {
					engines?: { node?: string };
				};
				const engine = packageJson.engines?.node;
				if (typeof engine === "string") {
					const match = /\d+/.exec(engine);
					if (match) return match[0];
				}
			} catch {
				return "20";
			}
		}

		return "20";
	},
};

export default handler;
