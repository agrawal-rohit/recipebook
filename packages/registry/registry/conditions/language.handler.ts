import type { ConditionHandler } from "@pebbles/core";

/** Marker files that imply a language when any listed path exists under the project root. */
const LANGUAGE_MARKERS = [
	{ value: "typescript", files: ["tsconfig.json", "jsconfig.json"] },
] as const;

/** Suggest a language default from marker files in the project root. */
const handler: ConditionHandler = {
	async infer(ctx) {
		const allowed = new Set((ctx.values ?? []).map((entry) => entry.value));
		let match: string | undefined;

		for (const { value, files } of LANGUAGE_MARKERS) {
			if (!allowed.has(value)) continue;

			// Match when any marker file is present.
			const present = await Promise.all(
				files.map((file) => ctx.isFile(file)),
			);
			if (!present.some(Boolean)) continue;
			if (match !== undefined) return undefined;
			match = value;
		}

		return match;
	},
};

export default handler;
