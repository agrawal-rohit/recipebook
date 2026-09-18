/**
 * Helpers shared by the agent-instruction rule transform and the subagent
 * agent-definition transform beforeWrite hooks.
 */

/** Supported target coding agent or IDE formats. */
export type SupportedCodingAgentIDE =
	| "cursor"
	| "claude-code"
	| "copilot"
	| "codex"
	| "opencode";

/** Every IDE value accepted by the `codingAgentIDE` condition. */
export const SUPPORTED_CODING_AGENT_IDES = new Set<string>([
	"cursor",
	"claude-code",
	"copilot",
	"codex",
	"opencode",
]);

/**
 * Escape a string for safe embedding inside double-quoted YAML.
 * @param value - Raw string to escape.
 * @returns Escaped string.
 */
export function escapeDoubleQuotedYaml(value: string): string {
	return value
		.replaceAll("\\", String.raw`\\`)
		.replaceAll('"', String.raw`\"`)
		.replaceAll("\n", String.raw`\n`)
		.replaceAll("\r", String.raw`\r`)
		.replaceAll("\t", String.raw`\t`);
}

/**
 * Escape a string for safe embedding inside a TOML basic (double-quoted) string.
 * @param value - Raw string to escape.
 * @returns Escaped string.
 */
export function escapeDoubleQuotedToml(value: string): string {
	return value
		.replaceAll("\\", String.raw`\\`)
		.replaceAll('"', String.raw`\"`)
		.replaceAll("\n", String.raw`\n`)
		.replaceAll("\r", String.raw`\r`)
		.replaceAll("\t", String.raw`\t`)
		.replaceAll("\b", String.raw`\b`)
		.replaceAll("\f", String.raw`\f`);
}

/**
 * Strip a matching pair of single or double quotes from a scalar string.
 * @param value - Scalar string that may carry surrounding quotes.
 * @returns Unquoted scalar string.
 */
export function stripMatchingQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed.at(-1);
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

/**
 * Extract the optional YAML frontmatter block and remaining body from a markdown document.
 * @param content - Full markdown document.
 * @returns Frontmatter block string and markdown body.
 */
export function extractMarkdownFrontmatter(content: string): {
	frontmatterRaw?: string;
	body: string;
} {
	const normalized = content.replaceAll("\r\n", "\n");
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
	if (!match) return { body: normalized };
	return {
		frontmatterRaw: match[1],
		body: match[2].replace(/^\n+/, ""),
	};
}

/**
 * Parse a YAML list of strings from either flow-style `["a", "b"]` or block-style `- a`.
 * @param raw - Raw string containing list elements.
 * @returns Parsed array of trimmed strings.
 */
export function parseYamlStringList(raw: string): string[] {
	const trimmed = raw.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((entry) => stripMatchingQuotes(entry))
			.filter((entry) => entry.length > 0);
	}
	return trimmed
		.split("\n")
		.map((line) => line.replace(/^\s*-\s*/, "").trim())
		.map((entry) => stripMatchingQuotes(entry))
		.filter((entry) => entry.length > 0);
}
