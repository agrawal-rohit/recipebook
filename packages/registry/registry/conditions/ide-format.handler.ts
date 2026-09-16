import type { ConditionHandler } from "@pebbles/core";

/** Marker entries that reveal which IDE or coding agent a project is configured for. */
interface IdeMarker {
	value: string;
	files?: string[];
	directories?: string[];
}

const IDE_MARKERS: readonly IdeMarker[] = [
	{
		value: "cursor",
		directories: [".cursor/rules"],
		files: [".cursorrules", ".cursor/settings.json"],
	},
	{
		value: "claude-code",
		files: [".claude/config.json", ".claude.json", "CLAUDE.md"],
	},
	{
		value: "copilot",
		files: [".github/copilot-instructions.md"],
	},
	{ value: "codex", files: ["AGENTS.md"] },
	{ value: "opencode", files: ["opencode.json"] },
];

/** Suggest an IDE format from existing project markers. */
const handler: ConditionHandler = {
	async infer(ctx) {
		const allowed = new Set((ctx.values ?? []).map((entry) => entry.value));
		const isDir = ctx.isDirectory ?? ctx.isFile;

		for (const candidate of IDE_MARKERS) {
			if (!allowed.has(candidate.value)) continue;

			const checks: Array<Promise<boolean>> = [
				...(candidate.files ?? []).map((path) => ctx.isFile(path)),
				...(candidate.directories ?? []).map((path) => isDir(path)),
			];
			const present = await Promise.all(checks);
			if (present.some(Boolean)) return candidate.value;
		}

		return undefined;
	},
};

export default handler;
