import type {
	BeforeWriteHook,
	CompiledItemFile,
} from "@cheetos/core";
import {
	escapeDoubleQuotedToml,
	escapeDoubleQuotedYaml,
	extractMarkdownFrontmatter,
	parseYamlStringList,
	stripMatchingQuotes,
	SUPPORTED_CODING_AGENT_IDES,
	type SupportedCodingAgentIDE,
} from "../transform-shared";

/** Frontmatter parsed from an agent-definition markdown file. */
export interface AgentDefinitionFrontmatter {
	name?: string;
	description?: string;
	/**
	 * Extra passthrough keys (e.g. `tools`, `model`) preserved when re-rendering.
	 * Scalar values keep their raw source text verbatim (booleans stay unquoted,
	 * comma scalars stay unquoted); flow-style `[...]` values become arrays.
	 * Nested-map extras are dropped (see {@link parseAgentDefinitionDocument}).
	 */
	extra: Record<string, string | string[]>;
}

/**
 * Read the value of a non-reserved agent-frontmatter key.
 * Scalar values keep their raw text verbatim so booleans (`readonly: true`) and
 * comma scalars (`tools: Read, Grep, Glob, Bash`) round-trip unquoted; a
 * flow-style `[...]` value becomes an array; a block-style `- item` list on the
 * following lines becomes an array.
 * @param inlineVal - Raw text after the `key:` separator (may be empty).
 * @param lines - All frontmatter lines.
 * @param currentIndex - Index of the `key:` line within `lines`.
 * @returns Parsed extra value (undefined when unsupported) and how many additional lines were consumed.
 */
function readExtraValue(
	inlineVal: string,
	lines: string[],
	currentIndex: number,
): { value?: string | string[]; consumed: number } {
	const trimmed = inlineVal.trim();
	if (trimmed.startsWith("[")) {
		return { value: parseYamlStringList(trimmed), consumed: 0 };
	}
	if (trimmed.length > 0) return { value: trimmed, consumed: 0 };

	let consumed = 0;
	while (
		currentIndex + 1 + consumed < lines.length &&
		/^\s+-/.test(lines[currentIndex + 1 + consumed])
	) {
		consumed++;
	}
	if (consumed === 0) {
		// Nested-map extras (e.g. opencode `permission:`) are unsupported and
		// dropped, never re-emitted as broken YAML.
		return { consumed: 0 };
	}
	return {
		value: parseYamlStringList(
			lines.slice(currentIndex + 1, currentIndex + 1 + consumed).join("\n"),
		),
		consumed,
	};
}

/**
 * Parse an agent-definition markdown document into frontmatter and body.
 * Recognizes `name`, `description`, and `mode` explicitly; every other key is
 * preserved in `extra` for round-tripping.
 * @param content - Full agent-definition markdown content.
 * @returns Parsed frontmatter and markdown body.
 */
export function parseAgentDefinitionDocument(content: string): {
	frontmatter: AgentDefinitionFrontmatter;
	body: string;
} {
	const { frontmatterRaw, body } = extractMarkdownFrontmatter(content);
	if (!frontmatterRaw) return { frontmatter: { extra: {} }, body };

	const frontmatter: AgentDefinitionFrontmatter = { extra: {} };
	const lines = frontmatterRaw.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Only top-level keys (column 0) are recognized. Nested-map children
		// (e.g. the `read:`/`edit:` under opencode's `permission:`) are thus
		// never promoted to extras.
		const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
		if (!match) continue;
		const [, key, rawValue] = match;
		const value = stripMatchingQuotes(rawValue);

		switch (key) {
			case "name":
				frontmatter.name = value;
				break;
			case "description":
				frontmatter.description = value;
				break;
			case "mode":
			case "globs":
			case "alwaysApply":
				// Cursor-rule-only keys are dropped for agent definitions.
				break;
			default: {
				const { value: extra, consumed } = readExtraValue(rawValue, lines, i);
				if (extra !== undefined) frontmatter.extra[key] = extra;
				i += consumed;
			}
		}
	}

	return { frontmatter, body };
}

/**
 * Derive the agent's `name` from frontmatter or fall back to the filename stem.
 * @param frontmatter - Parsed agent-definition frontmatter.
 * @param fallbackName - Name derived from the file name (stem) when frontmatter lacks `name`.
 * @returns Effective agent name.
 */
function agentName(frontmatter: AgentDefinitionFrontmatter, fallbackName: string): string {
	return frontmatter.name ?? fallbackName;
}

/**
 * Render extra keys as YAML frontmatter lines. Scalars re-emit their raw text
 * verbatim; arrays become block lists with double-quoted items.
 * @param extras - Parsed extra keys and values.
 * @returns Newline-joined frontmatter lines (no leading newline).
 */
function renderYamlExtras(extras: Record<string, string | string[]>): string {
	const lines: string[] = [];
	for (const [key, entry] of Object.entries(extras)) {
		if (Array.isArray(entry)) {
			lines.push(
				`${key}:\n${entry
					.map((item) => `  - "${escapeDoubleQuotedYaml(item)}"`)
					.join("\n")}`,
			);
		} else {
			lines.push(`${key}: ${entry}`);
		}
	}
	return lines.join("\n");
}

/**
 * Render extra keys as TOML assignments. Scalars become double-quoted TOML
 * strings; arrays become `["a", "b"]` arrays.
 * @param extras - Parsed extra keys and values.
 * @returns Newline-joined TOML lines (no trailing newline).
 */
function renderTomlExtras(extras: Record<string, string | string[]>): string {
	const lines: string[] = [];
	for (const [key, entry] of Object.entries(extras)) {
		if (Array.isArray(entry)) {
			lines.push(
				`${key} = [${entry
					.map((item) => `"${escapeDoubleQuotedToml(item)}"`)
					.join(", ")}]`,
			);
		} else {
			lines.push(`${key} = "${escapeDoubleQuotedToml(entry)}"`);
		}
	}
	return lines.join("\n");
}

/**
 * Render one agent-definition file for the requested IDE.
 * - cursor: passthrough at `.cursor/agents/<name>.md`.
 * - claude-code: `.claude/agents/<name>.md` with Claude-style agent frontmatter
 *   (`name`, `description`, plus preserved extras).
 * - copilot: `.github/agents/<name>.md` with `name`/`description` frontmatter.
 * - codex: `.codex/agents/<name>.toml` with `name`, `description`, and the body
 *   embedded as escaped `developer_instructions`.
 * - opencode: `.opencode/agents/<name>.md` frontmatter extended with `mode: subagent`.
 * @param sourceContent - Raw agent-definition markdown content (Cursor-format source).
 * @param fallbackName - Name derived from the source file stem (used when frontmatter has no `name`).
 * @param codingAgentIDE - Target IDE.
 * @returns Target file path and rendered content.
 */
export function renderAgentDefinition(
	sourceContent: string,
	fallbackName: string,
	codingAgentIDE: SupportedCodingAgentIDE,
): { target: string; content: string } {
	const { frontmatter, body } = parseAgentDefinitionDocument(sourceContent);
	const name = agentName(frontmatter, fallbackName);

	switch (codingAgentIDE) {
		case "cursor":
			return {
				target: `.cursor/agents/${name}.md`,
				content: sourceContent,
			};
		case "claude-code": {
			const extras = renderYamlExtras(frontmatter.extra);
			const extrasBlock = extras.length > 0 ? `\n${extras}` : "";
			return {
				target: `.claude/agents/${name}.md`,
				content: `---\nname: "${escapeDoubleQuotedYaml(name)}"\ndescription: "${escapeDoubleQuotedYaml(frontmatter.description ?? name)}"${extrasBlock}\n---\n\n${body}`,
			};
		}
		case "copilot": {
			const extras = renderYamlExtras(frontmatter.extra);
			const extrasBlock = extras.length > 0 ? `\n${extras}` : "";
			return {
				target: `.github/agents/${name}.md`,
				content: `---\nname: "${escapeDoubleQuotedYaml(name)}"\ndescription: "${escapeDoubleQuotedYaml(frontmatter.description ?? name)}"${extrasBlock}\n---\n\n${body}`,
			};
		}
		case "codex": {
			const instructions = escapeDoubleQuotedToml(body.trim());
			const description = escapeDoubleQuotedToml(frontmatter.description ?? name);
			const extras = renderTomlExtras(frontmatter.extra);
			const extrasBlock = extras.length > 0 ? `\n${extras}` : "";
			return {
				target: `.codex/agents/${name}.toml`,
				content: `name = "${escapeDoubleQuotedToml(name)}"\ndescription = "${description}"\ndeveloper_instructions = "${instructions}"${extrasBlock}\n`,
			};
		}
		case "opencode": {
			const extras = renderYamlExtras(frontmatter.extra);
			const extrasBlock = extras.length > 0 ? `\n${extras}` : "";
			return {
				target: `.opencode/agents/${name}.md`,
				content: `---\ndescription: "${escapeDoubleQuotedYaml(frontmatter.description ?? name)}"\nmode: subagent${extrasBlock}\n---\n\n${body}`,
			};
		}
		default: {
			const exhaustive: never = codingAgentIDE;
			throw new Error(`Unhandled IDE format "${String(exhaustive)}".`);
		}
	}
}

/**
 * Decide whether a compiled file is an agent-definition source (a `.cursor/agents/*` target).
 * @param file - Compiled item file.
 * @returns True when the file targets Cursor's agent directory.
 */
function isAgentDefinitionFile(file: CompiledItemFile): boolean {
	return file.target.startsWith(".cursor/agents/") && file.target.endsWith(".md");
}

/** `beforeWrite` hook that transforms Cursor agent-definition files for the selected IDE format. */
const transformAgentDefinitionForIde: BeforeWriteHook = async (ctx) => {
	const codingAgentIDERaw = ctx.conditions.codingAgentIDE;
	if (typeof codingAgentIDERaw !== "string" || !SUPPORTED_CODING_AGENT_IDES.has(codingAgentIDERaw)) {
		throw new Error(
			`Condition "codingAgentIDE" must be one of ${[...SUPPORTED_CODING_AGENT_IDES].join(", ")} to install agent "${ctx.itemId}".`,
		);
	}

	// Default target in files is already Cursor format: no-op when Cursor is chosen
	if (codingAgentIDERaw === "cursor") return;

	const agentFiles = ctx.compiledItem.files.filter(isAgentDefinitionFile);
	if (agentFiles.length === 0) {
		throw new Error(
			`Item "${ctx.itemId}" has no .cursor/agents/*.md source file to transform.`,
		);
	}

	const renderedAgents = agentFiles.map((file) => {
		const fallbackName = file.target.split("/").pop()?.replace(/\.md$/, "") ?? "";
		return renderAgentDefinition(
			file.content,
			fallbackName,
			codingAgentIDERaw as SupportedCodingAgentIDE,
		);
	});

	return {
		files: renderedAgents,
		removeFiles: agentFiles.map((file) => file.target),
	};
};

export default transformAgentDefinitionForIde;
