import type { BeforeWriteHook } from "@pebbles/core";

/** Supported target coding agent or IDE formats. */
export type SupportedCodingAgentIDE =
	| "cursor"
	| "claude-code"
	| "copilot"
	| "codex"
	| "opencode";

const SUPPORTED_CODING_AGENT_IDES = new Set<string>([
	"cursor",
	"claude-code",
	"copilot",
	"codex",
	"opencode",
]);

/** Frontmatter parsed from a Cursor `.mdc` rule file. */
export interface CursorRuleFrontmatter {
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
}

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

/**
 * Parse the value of the `globs` frontmatter field, including any continuation block-list lines.
 * @param inlineVal - Inline value after `globs:` on the same line.
 * @param lines - All frontmatter lines.
 * @param currentIndex - Index of the `globs:` line within `lines`.
 * @returns Parsed globs array and how many additional lines were consumed.
 */
function readGlobsField(
	inlineVal: string,
	lines: string[],
	currentIndex: number,
): { globs?: string[]; consumed: number } {
	const trimmed = inlineVal.trim();
	if (trimmed.startsWith("[")) {
		return { globs: parseYamlStringList(trimmed), consumed: 0 };
	}
	if (trimmed.length > 0) {
		return { globs: [stripMatchingQuotes(trimmed)], consumed: 0 };
	}

	const blockLines: string[] = [];
	let consumed = 0;
	while (
		currentIndex + 1 + consumed < lines.length &&
		/^\s+-\s+/.test(lines[currentIndex + 1 + consumed])
	) {
		blockLines.push(lines[currentIndex + 1 + consumed]);
		consumed++;
	}

	return {
		globs:
			blockLines.length > 0
				? parseYamlStringList(blockLines.join("\n"))
				: undefined,
		consumed,
	};
}

/**
 * Parse a Cursor `.mdc` rule document into frontmatter metadata and markdown body.
 * @param content - Full `.mdc` file content.
 * @returns Parsed frontmatter and markdown body.
 */
export function parseCursorRuleDocument(content: string): {
	frontmatter: CursorRuleFrontmatter;
	body: string;
} {
	const { frontmatterRaw, body } = extractMarkdownFrontmatter(content);
	if (!frontmatterRaw) return { frontmatter: {}, body };

	const frontmatter: CursorRuleFrontmatter = {};
	const lines = frontmatterRaw.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		const descMatch = /^\s*description\s*:\s*(.+)$/.exec(line);
		if (descMatch) {
			frontmatter.description = stripMatchingQuotes(descMatch[1]);
			continue;
		}

		const applyMatch = /^\s*alwaysApply\s*:\s*(true|false)\s*$/.exec(line);
		if (applyMatch) {
			frontmatter.alwaysApply = applyMatch[1] === "true";
			continue;
		}

		const globsMatch = /^\s*globs\s*:\s*(.*)$/.exec(line);
		if (globsMatch) {
			const { globs, consumed } = readGlobsField(globsMatch[1], lines, i);
			if (globs) frontmatter.globs = globs;
			i += consumed;
		}
	}

	return { frontmatter, body };
}

/** Render an untouched Cursor `.mdc` rule at its canonical destination. */
function renderCursorRule(ruleContent: string, ruleName: string): {
	target: string;
	content: string;
} {
	return {
		target: `.cursor/rules/${ruleName}.mdc`,
		content: ruleContent,
	};
}

/** Render a Claude Code rule from Cursor frontmatter. */
function renderClaudeCodeRule(ruleContent: string, ruleName: string): {
	target: string;
	content: string;
} {
	const { frontmatter, body } = parseCursorRuleDocument(ruleContent);
	const description = frontmatter.description ?? ruleName;
	const pathLines = (frontmatter.globs ?? [])
		.map((glob) => `  - "${escapeDoubleQuotedYaml(glob)}"`)
		.join("\n");
	const paths = pathLines.length > 0 ? `\npaths:\n${pathLines}` : "";
	return {
		target: `.claude/rules/${ruleName}.md`,
		content: `---\ndescription: "${escapeDoubleQuotedYaml(description)}"${paths}\n---\n\n${body}`,
	};
}

/** Render a GitHub Copilot instruction file from Cursor frontmatter. */
function renderCopilotRule(ruleContent: string, ruleName: string): {
	target: string;
	content: string;
} {
	const { frontmatter, body } = parseCursorRuleDocument(ruleContent);
	const applyTo = frontmatter.globs?.[0] ?? "**/*";
	return {
		target: `.github/instructions/${ruleName}.instructions.md`,
		content: `---\napplyTo: "${escapeDoubleQuotedYaml(applyTo)}"\n---\n\n${body}`,
	};
}

/** Render an OpenAI Codex or OpenCode AGENTS.md entry from Cursor rule body. */
function renderCodexOrOpenCodeRule(
	ruleContent: string,
	ruleName: string,
	existingContent?: string,
): {
	target: string;
	content: string;
} {
	const { body } = parseCursorRuleDocument(ruleContent);
	const section = `<!-- Generated by \`pebbles agent-instructions\` (${ruleName}) -->\n\n${body}`;

	if (existingContent && existingContent.trim().length > 0) {
		const marker = `<!-- Generated by \`pebbles agent-instructions\` (${ruleName}) -->`;
		if (existingContent.includes(marker))
			return { target: "AGENTS.md", content: existingContent };
		
		return {
			target: "AGENTS.md",
			content: `${existingContent.trimEnd()}\n\n---\n\n${section}\n`,
		};
	}

	return {
		target: "AGENTS.md",
		content: `${section}\n`,
	};
}

/**
 * Render an agent rule for the requested coding agent or IDE format.
 * @param ruleContent - Raw Cursor `.mdc` rule content.
 * @param ruleName - Normalized rule name (e.g. `code-standards`).
 * @param codingAgentIDE - Chosen target format from conditions.
 * @param existingTargetContent - Optional existing file content when merging files like AGENTS.md.
 * @returns Target file path and rendered content.
 */
export function renderAgentRule(
	ruleContent: string,
	ruleName: string,
	codingAgentIDE: SupportedCodingAgentIDE,
	existingTargetContent?: string,
): { target: string; content: string } {
	switch (codingAgentIDE) {
		case "cursor":
			return renderCursorRule(ruleContent, ruleName);
		case "claude-code":
			return renderClaudeCodeRule(ruleContent, ruleName);
		case "copilot":
			return renderCopilotRule(ruleContent, ruleName);
		case "codex":
		case "opencode":
			return renderCodexOrOpenCodeRule(
				ruleContent,
				ruleName,
				existingTargetContent,
			);
		default: {
			const exhaustive: never = codingAgentIDE;
			throw new Error(`Unhandled IDE format "${String(exhaustive)}".`);
		}
	}
}

/** `beforeWrite` hook that transforms Cursor `.mdc` rule files for the selected IDE format. */
const transformAgentRuleForIde: BeforeWriteHook = async (ctx) => {
	const codingAgentIDERaw = ctx.conditions.codingAgentIDE;
	if (typeof codingAgentIDERaw !== "string" || !SUPPORTED_CODING_AGENT_IDES.has(codingAgentIDERaw)) {
		throw new Error(
			`Condition "codingAgentIDE" must be one of ${[...SUPPORTED_CODING_AGENT_IDES].join(", ")} to install rule "${ctx.itemId}".`,
		);
	}

	// Default target in files is already Cursor format: no-op when Cursor is chosen
	if (codingAgentIDERaw === "cursor") return;

	const sourceFile = ctx.compiledItem.files[0];
	if (!sourceFile) {
		throw new Error(
			`Item "${ctx.itemId}" has no compiled source file to transform.`,
		);
	}

	const ruleName = sourceFile.target
		.split("/")
		.pop()
		?.replace(/\.mdc$/, "") ?? "";

	let existingTargetContent: string | undefined;
	const workingAgentsMd = ctx.compiledItem.files.find(
		(file) => file.target === "AGENTS.md",
	);
	if (workingAgentsMd) 
		existingTargetContent = workingAgentsMd.content;
	else if (
		(codingAgentIDERaw === "codex" || codingAgentIDERaw === "opencode") &&
		(await ctx.isFile("AGENTS.md"))
	) {
		try {
			existingTargetContent = await ctx.readFile("AGENTS.md");
		} catch {
			// Ignore read error
		}
	}

	const rendered = renderAgentRule(
		sourceFile.content,
		ruleName,
		codingAgentIDERaw as SupportedCodingAgentIDE,
		existingTargetContent,
	);

	return {
		files: [rendered],
		removeFiles: [sourceFile.target],
	};
};

export default transformAgentRuleForIde;