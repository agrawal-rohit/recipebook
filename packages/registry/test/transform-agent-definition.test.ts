import { describe, expect, it } from "vitest";
// Import via the .js extension: this package's tests run under `vitest` with
// node resolution (module: CommonJS, moduleResolution: bundler, no built-in
// extensionless resolution), matching the .js specifier used for TS sources.
// The module's public contract is a DEFAULT export for the hook plus named
// exports for the helpers, so the hook is imported default and helpers named.
import transformAgentDefinitionForIde, {
	parseAgentDefinitionDocument,
	renderAgentDefinition,
} from "../registry/subagents/transform-agent-definition.before-write.js";

// The hook's context type (BeforeWriteHook) is not exported by the module and the
// full compiled run unifies more fields than this test drives. We therefore build
// a *structural* context (the subset the hook reads: itemId, conditions,
// compiledItem.files, isFile, readFile) and cast through unknown so the test is
// written against the public contract only and stays robust to added context
// fields in the future.
type SourceFile = { target: string; content: string };
type HookContext = {
	itemId: string;
	conditions: { codingAgentIDE: string };
	compiledItem: { files: SourceFile[] };
	isFile: (path: string) => Promise<boolean>;
	readFile: (path: string) => Promise<string>;
};

// A single agent with dense extras covering every round-trip concern: a
// verbatim unquoted scalar, a comma scalar, a quoted scalar, a flow list, a
// block list with a blank entry, and a nested-map extra.
const AGENT_TARGET = ".cursor/agents/exam-agent.md";
const AGENT_CONTENT = [
	"---",
	"name: Exam Agent",
	"description: Low-level build agent with a strict set of tools",
	"tools: [run, read]",
	"model: light-4o",
	"region: us,eu",
	'label: "the-label"',
	"enabled: true",
	"commit-style:",
	"  - fix",
	"  - feat",
	'  - " "',
	"tags:",
	"  - one",
	"  -",
	"  - two",
	"context:",
	"  project: docs",
	"  stack: ts",
	"settings: passive",
	"---",
	"Run the build, agents, and take instructions from /refs.",
].join("\n");

function fakeContext(overrides: Partial<HookContext> = {}): HookContext {
	return {
		itemId: "exam-agent",
		conditions: { codingAgentIDE: "claude-code" },
		compiledItem: { files: [{ target: AGENT_TARGET, content: AGENT_CONTENT }] },
		isFile: async () => false,
		readFile: async () => {
			throw new Error("readFile stub should not be called");
		},
		...overrides,
	};
}

function findFile(
	files: SourceFile[] | undefined,
	target: string,
): SourceFile | undefined {
	return files?.find((f) => f.target === target);
}

// ---------------------------------------------------------------------------
// RC-3 — agent-only items transform the agent and write no rule file.
// RC-4 — no files of a hook's kind → a clear Error naming the item id.
// RC-5 — cursor is a no-op (returns without modifying files).
// ---------------------------------------------------------------------------
describe("RC-3/RC-4/RC-5 agent hook selection and no-ops", () => {
	// SPEC: agent-rule-transform#RC-3
	it("transforms the agent and writes no rule file for an agent-only item", async () => {
		const out = await transformAgentDefinitionForIde(
			fakeContext() as unknown as Parameters<
				typeof transformAgentDefinitionForIde
			>[0],
		);
		expect(out).toBeDefined();
		// Wrong impl caught: agent target rendered through a rule renderer
		// (writing .claude/rules/...), or kept at the .cursor source target.
		expect(out!.files.some((f) => f.target.startsWith(".claude/rules/"))).toBe(
			false,
		);
		expect(findFile(out!.files, AGENT_TARGET)).toBeUndefined();
		// Wrong impl caught: source target not listed for removal.
		expect(out!.removeFiles).toContain(AGENT_TARGET);
	});

	// SPEC: agent-rule-transform#RC-3, RC-4
	it("throws naming the item id when only a rule file is present", async () => {
		const ctx = fakeContext({
			compiledItem: {
				files: [{ target: ".cursor/rules/test-quality.mdc", content: "x" }],
			},
		});
		// Wrong impl caught: agent hook that selects by first array index and
		// treats the rule file as an agent definition.
		await expect(
			transformAgentDefinitionForIde(
				ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
			),
		).rejects.toThrow(/exam-agent/);
	});

	// SPEC: agent-rule-transform#RC-4
	it("throws an Error naming the item id on empty files", async () => {
		const ctx = fakeContext({ compiledItem: { files: [] } });
		// Wrong impl caught: generic error without item id, or silent undefined.
		await expect(
			transformAgentDefinitionForIde(
				ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
			),
		).rejects.toThrow(/exam-agent/);
	});

	// SPEC: agent-rule-transform#RC-5
	it("cursor is a no-op: returns without modifying files", async () => {
		const ctx = fakeContext({ conditions: { codingAgentIDE: "cursor" } });
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		// Wrong impl caught: cursor path that still renders (returns
		// {files, removeFiles}) instead of returning undefined.
		expect(out).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// RC-11 — the agent `name` used in targets comes from frontmatter `name` when
// present, else the source filename stem.
// ---------------------------------------------------------------------------
describe("RC-11 agent name drives the target", () => {
	// SPEC: agent-rule-transform#RC-11
	it("uses frontmatter name when present (spaces preserved in path)", async () => {
		const out = await transformAgentDefinitionForIde(
			fakeContext() as unknown as Parameters<
				typeof transformAgentDefinitionForIde
			>[0],
		);
		// Wrong impl caught: slug tokenizer.
		expect(findFile(out!.files, ".claude/agents/Exam Agent.md")).toBeDefined();
	});

	// SPEC: agent-rule-transform#RC-11 (fallback to source filename stem)
	it("falls back to the filename stem when frontmatter has no name", async () => {
		const ctx = fakeContext({
			compiledItem: {
				files: [
					{
						target: AGENT_TARGET,
						content: ["---", "description: d", "---", "body"].join("\n"),
					},
				],
			},
		});
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		// Wrong impl caught: name fallback that errors or drops the file.
		expect(findFile(out!.files, ".claude/agents/exam-agent.md")).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// RC-6..RC-10 — per-IDE targets and shape.
// ---------------------------------------------------------------------------
describe("RC-6..RC-10 per-IDE targets and shape", () => {
	// SPEC: agent-rule-transform#RC-6
	it("cursor passthrough at .cursor/agents/ is only reachable via renderAgentDefinition", () => {
		// The hook is a no-op for cursor (RC-5), so the passthrough renderer is
		// the only public path that produces `.cursor/agents/<name>.md`.
		const rendered = renderAgentDefinition(
			AGENT_CONTENT,
			"exam-agent",
			"cursor",
		);
		// Wrong impl caught: cursor rendered at another agent path.
		expect(rendered.target).toBe(".cursor/agents/Exam Agent.md");
		expect(rendered.content).toBe(AGENT_CONTENT);
	});

	// SPEC: agent-rule-transform#RC-7
	it("claude-code targets .claude/agents/<name>.md with double-quoted name and description, extras, body", async () => {
		const out = await transformAgentDefinitionForIde(
			fakeContext() as unknown as Parameters<
				typeof transformAgentDefinitionForIde
			>[0],
		);
		const file = findFile(out!.files, ".claude/agents/Exam Agent.md");
		expect(file).toBeDefined();
		// Wrong impl caught: claude-code writing to .github/ or .codex/.
		expect(out!.files.some((f) => f.target.endsWith(".toml"))).toBe(false);
		// Wrong impl caught: frontmatter values left unquoted.
		expect(file!.content).toMatch(
			/^---\nname: "Exam Agent"\ndescription: "Low-level build agent with a strict set of tools"/,
		);
		// Extras retained.
		expect(file!.content).toContain("model: light-4o");
		// Body retained after the closing frontmatter.
		expect(file!.content).toContain(
			"Run the build, agents, and take instructions from /refs.",
		);
	});

	// SPEC: agent-rule-transform#RC-8
	it("copilot targets .github/agents/<name>.md with the same frontmatter shape as claude-code", async () => {
		const ctx = fakeContext({ conditions: { codingAgentIDE: "copilot" } });
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		const file = findFile(out!.files, ".github/agents/Exam Agent.md");
		expect(file).toBeDefined();
		expect(file!.content).toMatch(
			/^---\nname: "Exam Agent"\ndescription: "Low-level build agent with a strict set of tools"/,
		);
		// Wrong impl caught: copilot misrouted to .claude/agents/.
		expect(
			findFile(out!.files, ".claude/agents/Exam Agent.md"),
		).toBeUndefined();
		// Same extras shape as claude-code (RC-7).
		expect(file!.content).toContain("model: light-4o");
	});

	// SPEC: agent-rule-transform#RC-9
	it("codex targets .codex/agents/<name>.toml with name, description, developer_instructions, then extras", async () => {
		const ctx = fakeContext({ conditions: { codingAgentIDE: "codex" } });
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		const file = findFile(out!.files, ".codex/agents/Exam Agent.toml");
		expect(file).toBeDefined();
		// Wrong impl caught: codex rendering markdown frontmatter (#### name:).
		expect(file!.content).not.toContain("#### name:");
		// Wrong impl caught: unquoted/unescaped TOML values.
		expect(file!.content).toContain('name = "Exam Agent"');
		expect(file!.content).toContain(
			'description = "Low-level build agent with a strict set of tools"',
		);
		// Wrong impl caught: body written raw with a literal newline.
		expect(file!.content).toContain(
			'developer_instructions = "Run the build, agents, and take instructions from /refs."',
		);
		expect(file!.content).not.toContain(
			'developer_instructions = "Run the build\n',
		);
		// Extras follow as escaped TOML keys (scalar quoted).
		expect(file!.content).toContain('model = "light-4o"');
	});

	// SPEC: agent-rule-transform#RC-10
	it("opencode targets .opencode/agents/<name>.md with description, mode: subagent, extras, then body", async () => {
		const ctx = fakeContext({ conditions: { codingAgentIDE: "opencode" } });
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		const file = findFile(out!.files, ".opencode/agents/Exam Agent.md");
		expect(file).toBeDefined();
		// Wrong impl caught: opencode missing the `mode: subagent` marker, or
		// rendered with claude-code's #### headings.
		expect(file!.content).toContain("mode: subagent");
		expect(file!.content).not.toContain("#### name:");
		// Wrong impl caught: description missing.
		expect(file!.content).toContain(
			'description: "Low-level build agent with a strict set of tools"',
		);
		// Extras retained.
		expect(file!.content).toContain("model: light-4o");
	});
});

// ---------------------------------------------------------------------------
// RC-13 — scalar extras re-emitted verbatim: booleans and comma scalars stay
// unquoted.
// ---------------------------------------------------------------------------
describe("RC-13 scalar extras verbatim", () => {
	// SPEC: agent-rule-transform#RC-13
	it("renders extras exactly as written (comma scalars stay unquoted)", async () => {
		const out = await transformAgentDefinitionForIde(
			fakeContext() as unknown as Parameters<
				typeof transformAgentDefinitionForIde
			>[0],
		);
		const parsed = parseAgentDefinitionDocument(out!.files[0].content);
		// Wrong impl caught: formatting a comma scalar into a list (spits it at
		// the comma and would re-emit `region:` as a block list).
		expect(parsed.frontmatter.extra["region"]).toBe("us,eu");
		// Wrong impl caught: quoting/typing scalars (a boolean extra re-emitted
		// as the quoted string "true" instead of verbatim `true`).
		expect(parsed.frontmatter.extra["model"]).toBe("light-4o");
		expect(parsed.frontmatter.extra["settings"]).toBe("passive");
		expect(parsed.frontmatter.extra["enabled"]).toBe("true");
		// Verbatim: the raw source text after `label:` is `"the-label"` (the
		// quoted scalar keeps its quotes when re-emitted, per "verbatim as
		// written"; a scalar with double quotes in the source round-trips them).
		expect(parsed.frontmatter.extra["label"]).toBe('"the-label"');
		// Raw-output checks: parse cannot distinguish `enabled: true` from
		// `enabled: "true"` (both parse to "true"), so pin the unquoted form
		// the spec requires ("verbatim as written").
		expect(out!.files[0].content).toContain("enabled: true");
		// Wrong impl caught: stringifying the boolean into a quoted YAML scalar.
		expect(out!.files[0].content).not.toContain('enabled: "true"');
		// Wrong impl caught: quoting the comma scalar on re-emission (the spec
		// says comma scalars stay unquoted).
		expect(out!.files[0].content).toContain("region: us,eu");
	});
});

// ---------------------------------------------------------------------------
// RC-14 — lists: block format for claude-code/copilot/opencode, TOML arrays for
// codex; blank entries dropped; raw `- item` lines never leak.
// ---------------------------------------------------------------------------
describe("RC-14 list extras round-trip", () => {
	// SPEC: agent-rule-transform#RC-14
	it("renders a flow list as a YAML block list for claude-code", async () => {
		const out = await transformAgentDefinitionForIde(
			fakeContext() as unknown as Parameters<
				typeof transformAgentDefinitionForIde
			>[0],
		);
		const parsed = parseAgentDefinitionDocument(out!.files[0].content);
		// Wrong impl caught: serializing tools back to a flow list
		// `tools: [run, read]` instead of a block list.
		expect(parsed.frontmatter.extra["tools"]).toEqual(["run", "read"]);
	});

	// SPEC: agent-rule-transform#RC-14 (blank entries dropped)
	it("drops blank/whitespace-only block entries and keeps the rest in order", async () => {
		const out = await transformAgentDefinitionForIde(
			fakeContext() as unknown as Parameters<
				typeof transformAgentDefinitionForIde
			>[0],
		);
		const parsed = parseAgentDefinitionDocument(out!.files[0].content);
		// Wrong impl caught: keeping the blank `- " "` entry, OR treating the
		// blank entry as the END of the list (dropping "two") — the empty/blank
		// entry must be filtered, not truncate.
		expect(parsed.frontmatter.extra["tags"]).toEqual(["one", "two"]);
	});

	// SPEC: agent-rule-transform#RC-14 (codex array form)
	it("emits a TOML array for codex and escapes the list items", async () => {
		const ctx = fakeContext({ conditions: { codingAgentIDE: "codex" } });
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		// Wrong impl caught: YAML block-list syntax leaking into TOML.
		expect(out!.files[0].content).not.toMatch(/^ *- .+/m);
		expect(out!.files[0].content).toContain('tools = ["run", "read"]');
		// Wrong impl caught: blank entries preserved in the array.
		expect(out!.files[0].content).toContain('tags = ["one", "two"]');
	});
});

// ---------------------------------------------------------------------------
// RC-15 — nested-map extras are unsupported and dropped; keys following them in
// the frontmatter are still preserved.
// ---------------------------------------------------------------------------
describe("RC-15 nested-map extras dropped", () => {
	// SPEC: agent-rule-transform#RC-15
	it("drops the nested-map extra but keeps the keys following it", async () => {
		const out = await transformAgentDefinitionForIde(
			fakeContext() as unknown as Parameters<
				typeof transformAgentDefinitionForIde
			>[0],
		);
		const parsed = parseAgentDefinitionDocument(out!.files[0].content);
		// Wrong impl caught: the nested-map value kept as text, or `settings`
		// (the key after it) swallowed as part of the dropped map.
		expect(parsed.frontmatter.extra["context"]).toBeUndefined();
		expect(parsed.frontmatter.extra["settings"]).toBe("passive");
		expect(parsed.frontmatter.extra["label"]).toBe('"the-label"');
		// Wrong impl caught: nested children promoted as top-level keys.
		expect(parsed.frontmatter.extra["project"]).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// RC-16 — `description` is escaped with escapeDoubleQuotedYaml (or TOML escaping
// for codex) even when it contains quotes, backslashes, tab, CR, or newlines.
// ---------------------------------------------------------------------------
describe("RC-16 description escaping", () => {
	// One valid single-line plain YAML scalar containing quotes, backslash and
	// a real TAB. (Raw CR/newline would make the source invalid YAML — behavior
	// on invalid input is not spec-derivable.)
	const EVIL = 'He said "hi" \\ tab\tend';

	// SPEC: agent-rule-transform#RC-16 (claude-code)
	it("claude-code escapes quotes, backslash, tab in the description", async () => {
		const ctx = fakeContext({
			conditions: { codingAgentIDE: "claude-code" },
			compiledItem: {
				files: [
					{
						target: AGENT_TARGET,
						content: `---\nname: X\n` + `description: ${EVIL}\n` + `---\nb`,
					},
				],
			},
		});
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		// Wrong impl caught: raw tab written into the frontmatter, or
		// quotes/backslash left raw.
		expect(out!.files[0].content).not.toContain("\t");
		expect(out!.files[0].content).toContain('He said \\"hi\\" \\\\ tab');
	});

	// SPEC: agent-rule-transform#RC-16 (tab/CR/newline). The only well-defined
	// way a single-line YAML scalar carries control characters is the
	// double-quoted escape form, so drive them through that: the rendered
	// description must stay on one physical line with escape sequences inside
	// the quotes; raw emission fails.
	it("claude-code keeps escaped control characters on one line without raw controls", async () => {
		const ctx = fakeContext({
			conditions: { codingAgentIDE: "claude-code" },
			compiledItem: {
				files: [
					{
						target: AGENT_TARGET,
						content:
							`---\nname: X\n` +
							`description: "line1\\nline2\\tline3\\rline4"\n` +
							`---\nb`,
					},
				],
			},
		});
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		// Wrong impl caught: the value written raw, splitting the frontmatter
		// line (the single-line match below would fail).
		expect(out!.files[0].content).toMatch(/^description: ".*"$/m);
		// Wrong impl caught: raw tab/CR/newline written into the frontmatter
		// instead of escape sequences.
		expect(out!.files[0].content).not.toMatch(/^description: "[^"]*[\t\r\n]/m);
		expect(out!.files[0].content).toContain("\\n");
		expect(out!.files[0].content).toContain("\\t");
		expect(out!.files[0].content).toContain("\\r");
	});

	// SPEC: agent-rule-transform#RC-16 (codex; TOML escaping). The rule-side
	// equivalent is asserted in the rules test via the shared escaper.
	it("codex escapes quotes and backslash in the description", async () => {
		const evil = 'He said "hi" \\ there';
		const ctx = fakeContext({
			conditions: { codingAgentIDE: "codex" },
			compiledItem: {
				files: [
					{
						target: AGENT_TARGET,
						content: `---\nname: X\n` + `description: ${evil}\n` + `---\nb`,
					},
				],
			},
		});
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		// Wrong impl caught: raw quotes/backslash written into TOML.
		expect(out!.files[0].content).toContain(
			'description = "He said \\"hi\\" \\\\ there"',
		);
	});
});

// ---------------------------------------------------------------------------
// RC-17 — dropped keys (mode, globs, alwaysApply) never appear in rendered extras.
// ---------------------------------------------------------------------------
describe("RC-17 dropped keys never rendered", () => {
	function sourceWithReservedKeys() {
		return [
			"---",
			"name: X",
			"description: d",
			"mode: always",
			"globs:",
			'  - "**/*.ts"',
			"alwaysApply: true",
			"---",
			"body",
		].join("\n");
	}

	// SPEC: agent-rule-transform#RC-17 (claude-code has no mode emission at all)
	it("claude-code never renders mode/globs/alwaysApply", async () => {
		const ctx = fakeContext({
			conditions: { codingAgentIDE: "claude-code" },
			compiledItem: {
				files: [{ target: AGENT_TARGET, content: sourceWithReservedKeys() }],
			},
		});
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		// Wrong impl caught: a renderer that mirrors every frontmatter key.
		expect(out!.files[0].content).not.toContain("alwaysApply");
		expect(out!.files[0].content).not.toMatch(/^globs/m);
		expect(out!.files[0].content).not.toMatch(/^mode\b/m);
	});

	// SPEC: agent-rule-transform#RC-17 (opencode: source mode never leaks; the
	// generated `mode: subagent` marker from RC-10 is still present)
	it("opencode drops the source mode: always but still emits its own mode: subagent", async () => {
		const ctx = fakeContext({
			conditions: { codingAgentIDE: "opencode" },
			compiledItem: {
				files: [{ target: AGENT_TARGET, content: sourceWithReservedKeys() }],
			},
		});
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		expect(out!.files[0].content).not.toContain("alwaysApply");
		expect(out!.files[0].content).not.toMatch(/^globs/m);
		// Wrong impl caught: the source reserved value leaking into the output.
		expect(out!.files[0].content).not.toContain("mode: always");
		// Wrong impl caught: opencode emitting `mode` as a passthrough extra
		// from source instead of its fixed marker.
		//
		// RED NOTE (pre-split divergence): today's combined file renders
		// opencode by adding `mode: subagent` while ALSO forwarding the
		// source `mode: always`... (verified: emitters a `mode: always` leak).
		expect(out!.files[0].content).toContain("mode: subagent");
	});

	// SPEC: agent-rule-transform#RC-17 (codex: reserved keys must not appear
	// as TOML keys either — only name/description/developer_instructions/extras)
	it("codex never renders mode/globs/alwaysApply as TOML keys", async () => {
		const ctx = fakeContext({
			conditions: { codingAgentIDE: "codex" },
			compiledItem: {
				files: [{ target: AGENT_TARGET, content: sourceWithReservedKeys() }],
			},
		});
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		// Wrong impl caught: forwarding reserved keys into the TOML doc
		// (e.g. `mode = "always"`) or leaving them unquoted.
		expect(out!.files[0].content).not.toContain("alwaysApply");
		expect(out!.files[0].content).not.toMatch(/^globs(\s|=)/m);
		expect(out!.files[0].content).not.toMatch(/^mode(\s|=)/m);
	});
});

// ---------------------------------------------------------------------------
// RC-21 — the body written to codex `developer_instructions` is trimmed of
// surrounding whitespace; interior newlines preserved and escaped.
// ---------------------------------------------------------------------------
describe("RC-21 codex developer_instructions body", () => {
	// SPEC: agent-rule-transform#RC-21
	it("trims surrounding whitespace and preserves interior newlines as \\n", async () => {
		const padded = [
			"---",
			"name: X",
			"description: d",
			"---",
			"",
			"first line  ",
			"second line",
			"",
			"   ",
		].join("\n");
		const ctx = fakeContext({
			conditions: { codingAgentIDE: "codex" },
			compiledItem: { files: [{ target: AGENT_TARGET, content: padded }] },
		});
		const out = await transformAgentDefinitionForIde(
			ctx as unknown as Parameters<typeof transformAgentDefinitionForIde>[0],
		);
		const file = findFile(out!.files, ".codex/agents/X.toml");
		expect(file).toBeDefined();
		// Wrong impl caught: body written raw with a literal newline / trailing
		// whitespace, or the interior newline collapsed into a space.
		expect(file!.content).toContain(
			'developer_instructions = "first line  \\nsecond line"',
		);
		expect(file!.content).not.toMatch(/developer_instructions = "[^"]*\n/);
	});
});

// ---------------------------------------------------------------------------
// parseAgentDefinitionDocument — public interface given by the spec:
// frontmatter {name?, description?, extra: {key: string|string[]}}, plus body.
// ---------------------------------------------------------------------------
describe("parseAgentDefinitionDocument", () => {
	// SPEC: agent-rule-transform#RC-13 (comma scalar), RC-14 (lists), body
	it("parses name, description, extra keys, and body from source", () => {
		const parsed = parseAgentDefinitionDocument(AGENT_CONTENT);
		expect(parsed.frontmatter.name).toBe("Exam Agent");
		expect(parsed.frontmatter.description).toBe(
			"Low-level build agent with a strict set of tools",
		);
		// comma scalar stays a string, not split into a list
		expect(parsed.frontmatter.extra["region"]).toBe("us,eu");
		expect(parsed.frontmatter.extra["model"]).toBe("light-4o");
		expect(parsed.body).toBe(
			"Run the build, agents, and take instructions from /refs.",
		);
	});

	// SPEC: agent-rule-transform#RC-15 (nested maps dropped at parse time)
	it("does not promote nested-map children to extra keys", () => {
		const parsed = parseAgentDefinitionDocument(AGENT_CONTENT);
		expect(parsed.frontmatter.extra["context"]).toBeUndefined();
		expect(parsed.frontmatter.extra["project"]).toBeUndefined();
	});

	// SPEC: agent-rule-transform (frontmatter not part of the body)
	it("drops the frontmatter block from the body", () => {
		const parsed = parseAgentDefinitionDocument(AGENT_CONTENT);
		// Wrong impl caught: body that still contains the YAML markers.
		expect(parsed.body).not.toContain("---");
		expect(parsed.body).not.toContain("name:");
	});
});
