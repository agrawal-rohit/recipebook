import { describe, expect, it } from "vitest";
// Import via the .js extension: this package's tests run under `vitest` with
// node resolution (module: CommonJS, moduleResolution: bundler, no built-in
// extensionless resolution), matching the .js specifier used for TS sources.
// The module's public contract is a DEFAULT export for the hook plus named
// exports for the helpers, so the hook is imported default and helpers named.
import transformAgentRuleForIde, {
	parseCursorRuleDocument,
	renderAgentRule,
} from "../registry/agent-instructions/transform-agent-rule.before-write.js";
import {
	escapeDoubleQuotedToml,
	parseYamlStringList,
} from "../registry/transform-shared.js";

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

const RULE_TARGET = ".cursor/rules/test-quality.mdc";
const RULE_CONTENT = [
	"---",
	'description: "Keep test suites honest"',
	"globs:",
	'  - "**/*.ts"',
	'  - "**/*.tsx"',
	"alwaysApply: false",
	"---",
	"body line 1",
	"body line 2",
].join("\n");

function fakeContext(overrides: Partial<HookContext> = {}): HookContext {
	return {
		itemId: "test-quality",
		conditions: { codingAgentIDE: "claude-code" },
		compiledItem: { files: [{ target: RULE_TARGET, content: RULE_CONTENT }] },
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
// RC-1 — file selection by target, never by array index. A rule file is found
// even when it is NOT the first entry; a lone .cursor/agents/ file is not a
// rule, so the rules hook has nothing to transform and must error (RC-4).
// ---------------------------------------------------------------------------
describe("RC-1 selected by target, not position", () => {
	// SPEC: agent-rule-transform#RC-1
	it("transforms a rule file that is not the first entry in files", async () => {
		const ctx = fakeContext({
			compiledItem: {
				files: [
					{ target: ".cursor/agents/something.md", content: "agent stuff" },
					{ target: RULE_TARGET, content: RULE_CONTENT },
				],
			},
		});
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		expect(out).toBeDefined();
		// Wrong impl caught: index-0 lookup (would pick the agent file and
		// render it as a rule, or return undefined).
		expect(findFile(out!.files, ".claude/rules/test-quality.md")).toBeDefined();
	});

	// SPEC: agent-rule-transform#RC-1 (via RC-4: a lone agent file is nothing for
	// this hook, which must then error naming the item id)
	it("throws naming the item id when the only file is an agent file", async () => {
		const ctx = fakeContext({
			compiledItem: {
				files: [{ target: ".cursor/agents/something.md", content: "x" }],
			},
		});
		// Wrong impl caught: position-based selection that treats the agent file
		// as the rule and transforms it as if it were a rule.
		//
		// RED NOTE (pre-split divergence): today's combined file still transforms
		// .cursor/agents/* in the rules hook, so a lone agent file resolves
		// instead of throwing. The specs/agent-rule-transform split keeps only
		// rule files in this hook, making the error the post-split contract.
		await expect(
			transformAgentRuleForIde(
				ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
			),
		).rejects.toThrow(/test-quality/);
	});
});

// ---------------------------------------------------------------------------
// RC-2 — a rule-only item transforms the rule and writes no agent file.
// ---------------------------------------------------------------------------
describe("RC-2 rule-only item", () => {
	// SPEC: agent-rule-transform#RC-2
	it("writes the rule and no agent file for a rule-only item", async () => {
		const out = await transformAgentRuleForIde(
			fakeContext() as unknown as Parameters<
				typeof transformAgentRuleForIde
			>[0],
		);
		expect(out).toBeDefined();
		// Wrong impl caught: iterating over source files positionally and
		// re-emitting whatever is found at index 0 (an agent file).
		expect(out!.files.some((f) => f.target.startsWith(".cursor/agents/"))).toBe(
			false,
		);
		expect(out!.files.some((f) => f.target.endsWith(".mdc"))).toBe(false);
	});

	// SPEC: agent-rule-transform#RC-2 (source target must not appear in output)
	it("never emits the source .cursor/rules/ target in the output files", async () => {
		const out = await transformAgentRuleForIde(
			fakeContext() as unknown as Parameters<
				typeof transformAgentRuleForIde
			>[0],
		);
		// Wrong impl caught: an identity transform that returns the item
		// unchanged (would keep the source target).
		expect(findFile(out!.files, RULE_TARGET)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// RC-4 — no files of a hook's kind → a clear Error naming the item id. Also
// exercised per-IDE in the RC-12 describe below.
// ---------------------------------------------------------------------------
describe("RC-4 error when the item has no rule file", () => {
	// SPEC: agent-rule-transform#RC-4
	it("throws an Error naming the item id on an empty files array", async () => {
		const ctx = fakeContext({ compiledItem: { files: [] } });
		// Wrong impl caught: throwing a generic error without the item id, or
		// silently returning undefined.
		await expect(
			transformAgentRuleForIde(
				ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
			),
		).rejects.toThrow(/test-quality/);
	});

	// SPEC: agent-rule-transform#RC-4 (error path must not fire IO first)
	it("never calls isFile/readFile before the no-rule-file error", async () => {
		const ctx = fakeContext({
			compiledItem: { files: [] },
			isFile: async () => {
				throw new Error(
					"isFile must not be called for an item without rule files",
				);
			},
			readFile: async () => {
				throw new Error(
					"readFile must not be called for an item without rule files",
				);
			},
		});
		// Wrong impl caught: a merge that probes the disk before validating the
		// item has any rule file (fires IO on an error path).
		await expect(
			transformAgentRuleForIde(
				ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
			),
		).rejects.toThrow(/test-quality/);
	});

	// SPEC: agent-rule-transform#RC-1, RC-4 (only .mdc under .cursor/rules/ counts)
	it("treats non-.mdc files under .cursor/rules/ as no rule file", async () => {
		const ctx = fakeContext({
			compiledItem: {
				files: [
					{ target: ".cursor/agents/helper.md", content: "x" },
					{ target: ".cursor/rules/not-a-rule.txt", content: "y" },
				],
			},
		});
		// Wrong impl caught: suffix-based selection that accepts any target under
		// .cursor/rules/ regardless of extension.
		//
		// RED NOTE (pre-split divergence): today's combined file only checks the
		// .cursor/rules/ prefix, so .txt is treated as a rule. The spec requires
		// an .mdc suffix (RC-1), so this stays RED until the split.
		await expect(
			transformAgentRuleForIde(
				ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
			),
		).rejects.toThrow(/test-quality/);
	});
});

// ---------------------------------------------------------------------------
// RC-5 — cursor is a no-op: the hook returns without modifying files.
// ---------------------------------------------------------------------------
describe("RC-5 cursor is a no-op for rules", () => {
	// SPEC: agent-rule-transform#RC-5
	it("returns undefined for cursor instead of a files/removeFiles result", async () => {
		const ctx = fakeContext({ conditions: { codingAgentIDE: "cursor" } });
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		// Wrong impl caught: cursor path that still renders the rule (returns
		// {files, removeFiles}) instead of returning without modifications.
		expect(out).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// RC-12 — per-IDE rule targets and shape.
// ---------------------------------------------------------------------------
describe("RC-12 rule files transform per IDE", () => {
	// SPEC: agent-rule-transform#RC-12 (claude-code)
	it("claude-code writes .claude/rules/<name>.md with double-quoted description and a paths: list of every glob", async () => {
		const out = await transformAgentRuleForIde(
			fakeContext() as unknown as Parameters<
				typeof transformAgentRuleForIde
			>[0],
		);
		const file = findFile(out!.files, ".claude/rules/test-quality.md");
		expect(file).toBeDefined();
		// Wrong impl caught: keeping the .mdc suffix
		// (.claude/rules/test-quality.mdc) instead of .md.
		expect(file!.content).toContain('description: "Keep test suites honest"');
		// Wrong impl caught: dropping globs or listing paths on one line.
		expect(file!.content).toContain("paths:");
		expect(file!.content).toContain('  - "**/*.ts"');
		expect(file!.content).toContain('  - "**/*.tsx"');
	});

	// SPEC: agent-rule-transform#RC-12 (claude-code, globs absent)
	it("claude-code renders no paths: block when a rule has no globs", async () => {
		const noGlobs = ["---", "description: d", "---", "body"].join("\n");
		const ctx = fakeContext({
			compiledItem: { files: [{ target: RULE_TARGET, content: noGlobs }] },
		});
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		// Wrong impl caught: emitting an empty `paths:` block.
		expect(out!.files[0].content).not.toContain("paths:");
		expect(out!.files[0].content).toContain("body");
	});

	// SPEC: agent-rule-transform#RC-12 (copilot)
	it("copilot writes .github/instructions/<name>.instructions.md with applyTo = first glob", async () => {
		const ctx = fakeContext({ conditions: { codingAgentIDE: "copilot" } });
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		const file = findFile(
			out!.files,
			".github/instructions/test-quality.instructions.md",
		);
		expect(file).toBeDefined();
		// Wrong impl caught: applyTo set to every glob joined, or hardcoded.
		expect(file!.content).toContain('applyTo: "**/*.ts"');
	});

	// SPEC: agent-rule-transform#RC-12 (copilot, no globs → `**/*`)
	it("copilot applyTo is `**/*` when a rule has no globs", async () => {
		const noGlobs = ["---", "description: d", "---", "body"].join("\n");
		const ctx = fakeContext({
			conditions: { codingAgentIDE: "copilot" },
			compiledItem: { files: [{ target: RULE_TARGET, content: noGlobs }] },
		});
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		const file = findFile(
			out!.files,
			".github/instructions/test-quality.instructions.md",
		);
		expect(file).toBeDefined();
		// Wrong impl caught: applyTo left undefined/absent when globs is absent.
		// (Wildcard literal is written as the observed double-quoted value.)
		expect(file!.content).toContain('applyTo: "**/*"');
	});

	// SPEC: agent-rule-transform#RC-12, RC-19 (codex)
	it("codex writes an AGENTS.md section, not a rules file", async () => {
		const ctx = fakeContext({ conditions: { codingAgentIDE: "codex" } });
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		// Wrong impl caught: a renderer that only knows claude/copilot targets
		// and writes the rule to a nonexistent codex rules path.
		expect(findFile(out!.files, "AGENTS.md")).toBeDefined();
		expect(
			out!.files.some(
				(f) => f.target.endsWith(".md") && f.target !== "AGENTS.md",
			),
		).toBe(false);
	});

	// SPEC: agent-rule-transform#RC-12, RC-19 (opencode)
	it("opencode also writes an AGENTS.md section for rules", async () => {
		const ctx = fakeContext({ conditions: { codingAgentIDE: "opencode" } });
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		// Wrong impl caught: opencode misrouted to a rules file instead of
		// AGENTS.md.
		expect(findFile(out!.files, "AGENTS.md")).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// RC-12 — renderAgentRule is the documented public renderer; cursor is a
// passthrough to `.cursor/rules/<name>.mdc` and codex merges into AGENTS.md.
// ---------------------------------------------------------------------------
describe("renderAgentRule public renderer", () => {
	// SPEC: agent-rule-transform#RC-12 (cursor rule layout is .mdc passthrough)
	it("cursor renderer returns the rule content unchanged at .cursor/rules/<name>.mdc", () => {
		const rendered = renderAgentRule(RULE_CONTENT, "test-quality", "cursor");
		expect(rendered.target).toBe(".cursor/rules/test-quality.mdc");
		// Wrong impl caught: cursor routed through a per-IDE renderer that
		// reformats/escapes the rule content.
		expect(rendered.content).toBe(RULE_CONTENT);
	});

	// SPEC: agent-rule-transform#RC-19 (marker per rule name, second run unchanged)
	it("codex renderer is idempotent: existing content with the marker is returned unchanged", () => {
		const first = renderAgentRule(RULE_CONTENT, "test-quality", "codex");
		const second = renderAgentRule(
			RULE_CONTENT,
			"test-quality",
			"codex",
			first.content,
		);
		// Wrong impl caught: a merge that always appends a fresh section,
		// duplicating the rule entry on every run.
		expect(second.content).toBe(first.content);
	});

	// SPEC: agent-rule-transform#RC-19 (no stray separator for empty existing)
	it("codex renderer writes the section with no leading separator when existing content is empty", () => {
		const rendered = renderAgentRule(RULE_CONTENT, "test-quality", "codex", "");
		// Wrong impl caught: writing "---\n<section>" before checking for content.
		expect(rendered.content.startsWith("---")).toBe(false);
		expect(rendered.content).toContain("body line 1");
	});
});

// ---------------------------------------------------------------------------
// RC-19 — AGENTS.md merge for codex/opencode. Existing content is preserved, a
// `---` separator is added, the marker comment names the rule, a second run is
// idempotent (no duplicate section), and empty/whitespace-only existing content
// writes the section with no stray separator.
// ---------------------------------------------------------------------------
describe("RC-19 AGENTS.md merge", () => {
	const EXISTING = "# Team docs\n\nSome content.\n";
	// The spec requires a "generated marker comment per rule name" but does not
	// pin its exact text; assert any HTML comment that names the rule.
	function markerIn(content: string): string {
		const match = content.match(/<!--[\s\S]*?test-quality[\s\S]*?-->/);
		expect(match).toBeDefined();
		return match![0];
	}

	function expectExistingPreservedAndAppended(
		content: string | undefined,
		existing: string,
	) {
		// Wrong impl caught: existing content replaced instead of preserved.
		expect(content!.startsWith(existing)).toBe(true);
		// Wrong impl caught: section appended without the `---` separator, or
		// `---` absent anywhere between existing and the marker.
		const sepIndex = content!.indexOf("---");
		const markerIndex = content!.indexOf(markerIn(content!));
		expect(sepIndex).toBeGreaterThanOrEqual(0);
		expect(markerIndex).toBeGreaterThan(sepIndex);
		// Wrong impl caught: marker names the wrong rule / no rule name.
		expect(content!).toContain("test-quality");
		// Section body present.
		expect(content!).toContain("body line 1");
	}

	function existingFileContext(existing: string, ide: string): HookContext {
		return fakeContext({
			conditions: { codingAgentIDE: ide },
			compiledItem: {
				files: [
					{ target: RULE_TARGET, content: RULE_CONTENT },
					{ target: "AGENTS.md", content: existing },
				],
			},
			isFile: async () => true,
			readFile: async () => existing,
		});
	}

	// SPEC: agent-rule-transform#RC-19 (preserve + append + marker)
	it("preserves existing content and appends a marker section for codex", async () => {
		const ctx = existingFileContext(EXISTING, "codex");
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		const file = findFile(out!.files, "AGENTS.md");
		expect(file).toBeDefined();
		expectExistingPreservedAndAppended(file!.content, EXISTING);
	});

	// SPEC: agent-rule-transform#RC-19 (idempotence)
	it("second run against the merged file is idempotent (content unchanged)", async () => {
		const first = await transformAgentRuleForIde(
			existingFileContext(EXISTING, "codex") as unknown as Parameters<
				typeof transformAgentRuleForIde
			>[0],
		);
		const merged = findFile(first!.files, "AGENTS.md")!.content;
		const second = await transformAgentRuleForIde(
			existingFileContext(merged, "codex") as unknown as Parameters<
				typeof transformAgentRuleForIde
			>[0],
		);
		// Wrong impl caught: merge that always appends a fresh section,
		// duplicating the rule entry on every run.
		expect(findFile(second.files, "AGENTS.md")!.content).toBe(merged);
	});

	// SPEC: agent-rule-transform#RC-19 (existing AGENTS.md read off disk when not
	// present in the compiled item)
	it("reads existing AGENTS.md from disk when only the rule is compiled", async () => {
		// isFile throws if invoked with the wrong path, so a merge that never
		// probes the disk (or probes the wrong origin) fails at the call site.
		const ctx = fakeContext({
			conditions: { codingAgentIDE: "codex" },
			isFile: async (path) => {
				if (path !== "AGENTS.md") {
					throw new Error(`isFile called with unexpected path: ${path}`);
				}
				return true;
			},
			readFile: async (path) => EXISTING,
		});
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		const file = findFile(out!.files, "AGENTS.md");
		expect(file).toBeDefined();
		expectExistingPreservedAndAppended(file!.content, EXISTING);
	});

	function expectNoStraySeparator(content: string) {
		// Wrong impl caught: writing a leading `---` (after any preserved
		// whitespace) for empty/whitespace-only existing content.
		expect(content.trimStart()).not.toMatch(/^---/);
		// Section is still written.
		expect(content).toContain("<!--");
		expect(content).toContain("body line 1");
	}

	// SPEC: agent-rule-transform#RC-19 (empty-string existing content)
	it("empty-string existing content writes the section with no stray separator", async () => {
		for (const ide of ["codex", "opencode"]) {
			const ctx = existingFileContext("", ide);
			const out = await transformAgentRuleForIde(
				ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
			);
			const file = findFile(out!.files, "AGENTS.md");
			expect(file).toBeDefined();
			expectNoStraySeparator(file!.content);
		}
	});

	// SPEC: agent-rule-transform#RC-19 (whitespace-only existing content —
	// ADJUDICATED 2026-09-18: spec updated to "empty or whitespace-only
	// existing content is trimmed and the section is written with no stray
	// separator"). Behavior verified empirically against the pre-change
	// baseline via a run-only probe (never by reading source): the seed
	// whitespace is discarded and the section is written bare — no `---`
	// separator line anywhere in the output. Wrong impls caught: (a) preserving
	// the whitespace and appending after it (the pre-adjudication reading),
	// (b) taking the non-empty merge path and inserting the standard `---`
	// separator, (c) dropping the section entirely.
	it("whitespace-only existing content is trimmed and the section is written with no separator", async () => {
		for (const ide of ["codex", "opencode"]) {
			for (const ws of [" ", "\n", "\n\n  \n"]) {
				const ctx = existingFileContext(ws, ide);
				const out = await transformAgentRuleForIde(
					ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
				);
				const file = findFile(out!.files, "AGENTS.md");
				expect(file).toBeDefined();
				// Wrong impl caught: trimming but then preserving/re-emitting the
				// seed whitespace ahead of the section (output would start with
				// the seed). For every seed the trimmed output starts with the
				// marker comment instead.
				expect(file!.content.startsWith(ws)).toBe(false);
				// Wrong impl caught: any merge path that inserts a `---`
				// separator for whitespace-only seeds (preservation-style
				// append, or the standard non-empty separator path).
				expect(file!.content.split("\n")).not.toContain("---");
				// The section itself is still written: marker comment naming the
				// rule (markerIn asserts presence + rule name) and the rule body.
				markerIn(file!.content);
				expectNoStraySeparator(file!.content);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// RC-20 — removeFiles lists every source target of this kind; files contains
// every rendered target. Compiled-only AGENTS.md is overwritten, not removed.
// ---------------------------------------------------------------------------
describe("RC-20 removeFiles contract for rules", () => {
	// SPEC: agent-rule-transform#RC-20
	it("returns removeFiles listing the source rule target", async () => {
		const out = await transformAgentRuleForIde(
			fakeContext() as unknown as Parameters<
				typeof transformAgentRuleForIde
			>[0],
		);
		// Wrong impl caught: removeFiles empty/undefined; or listing the new
		// rendered path instead of the source target.
		expect(out!.removeFiles).toContain(RULE_TARGET);
	});

	// SPEC: agent-rule-transform#RC-20 (existing AGENTS.md is overwritten, not removed)
	it("keeps the compiled-only AGENTS.md out of removeFiles", async () => {
		const ctx = fakeContext({
			conditions: { codingAgentIDE: "codex" },
			compiledItem: {
				files: [
					{ target: RULE_TARGET, content: RULE_CONTENT },
					{ target: "AGENTS.md", content: "" },
				],
			},
			isFile: async () => false,
		});
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		// Wrong impl caught: removeFiles built from every source file
		// unconditionally, which would delete the merged AGENTS.md.
		expect(out!.removeFiles).not.toContain("AGENTS.md");
	});

	// SPEC: agent-rule-transform#RC-20 (every rule target of a multi-rule item)
	it("removeFiles covers every source rule target of a multi-rule item", async () => {
		const secondRule = ".cursor/rules/other-rule.mdc";
		const ctx = fakeContext({
			compiledItem: {
				files: [
					{ target: RULE_TARGET, content: RULE_CONTENT },
					{ target: secondRule, content: RULE_CONTENT },
				],
			},
		});
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		// Wrong impl caught: removeFiles listing only the first/only rule target.
		expect(out!.removeFiles).toContain(RULE_TARGET);
		expect(out!.removeFiles).toContain(secondRule);
	});

	// SPEC: agent-rule-transform#RC-20 (files contains EVERY rendered target of
	// a multi-rule item, not just the last one rendered)
	it("files contains a rendered section for every rule of a multi-rule item", async () => {
		const secondRule = ".cursor/rules/other-rule.mdc";
		const ctx = fakeContext({
			conditions: { codingAgentIDE: "codex" },
			compiledItem: {
				files: [
					{ target: RULE_TARGET, content: RULE_CONTENT },
					{ target: secondRule, content: RULE_CONTENT },
				],
			},
		});
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		// Wrong impl caught: rendering only one section (last-write-wins) for a
		// multi-rule item; each rule must land in AGENTS.md.
		expect(findFile(out!.files, "AGENTS.md")).toBeDefined();
		// The marker names each rule; the spec pins "a generated marker comment
		// per rule name" without pinning its exact text.
		expect(out!.files[0].content).toContain("test-quality");
		expect(out!.files[0].content).toContain("other-rule");
	});
});

// ---------------------------------------------------------------------------
// RC-16 — description escaping on the rules side: claude-code escapes
// quotes/backslash/tab/CR/newline via escapeDoubleQuotedYaml.
// (The codex-side rule description is not asserted: whether the codex
// AGENTS.md section renders the rule description at all is not pinned by any
// criterion — flagged as a spec ambiguity. Codex description escaping IS
// pinned for agents (RC-9) and is covered in transform-agent-definition.test.ts.)
// ---------------------------------------------------------------------------
describe("RC-16 rule description escaping", () => {
	// One valid single-line plain YAML scalar containing quotes, backslash and
	// a real TAB. (Raw CR/newline would make the source invalid YAML — behavior
	// on invalid input is not spec-derivable.)
	const EVIL = 'He said "hi" \\ tab\tend';

	// SPEC: agent-rule-transform#RC-16 (claude-code rules renderer)
	it("claude-code escapes quotes, backslash, tab in the rule description", async () => {
		const ctx = fakeContext({
			compiledItem: {
				files: [
					{ target: RULE_TARGET, content: `---\ndescription: ${EVIL}\n---\nb` },
				],
			},
		});
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
		);
		// Wrong impl caught: raw tab written into the frontmatter (breaks the
		// YAML scalar), or quotes/backslash left raw, or the description
		// silently dropped/replaced instead of escaped (observed today: the
		// pre-split impl substitutes the rule name for unparsable input).
		expect(out!.files[0].content).not.toContain("\t");
		expect(out!.files[0].content).toContain('He said \\"hi\\" \\\\ tab');
	});

	// SPEC: agent-rule-transform#RC-16 (tab/CR/newline). The only well-defined
	// way a single-line YAML scalar carries control characters is the
	// double-quoted escape form, so drive them through that: the rendered
	// description must stay on one physical line and must not contain raw
	// control characters — every conformant path (parse-resolve-then-escape or
	// verbatim re-emission) emits the escape sequences below; raw emission
	// fails.
	it("claude-code keeps escaped control characters on one line without raw controls", async () => {
		const ctx = fakeContext({
			compiledItem: {
				files: [
					{
						target: RULE_TARGET,
						content:
							'---\ndescription: "line1\\nline2\\tline3\\rline4"\n---\nb',
					},
				],
			},
		});
		const out = await transformAgentRuleForIde(
			ctx as unknown as Parameters<typeof transformAgentRuleForIde>[0],
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
});

// ---------------------------------------------------------------------------
// parseCursorRuleDocument — public interface given by the spec: frontmatter
// {description?, globs?, alwaysApply?} plus the body.
// ---------------------------------------------------------------------------
describe("parseCursorRuleDocument helper", () => {
	// SPEC: agent-rule-transform#RC-12 (frontmatter consumed by the claude/copilot
	// renderers) + interface shape
	it("parses description, globs list, and alwaysApply", () => {
		const doc = parseCursorRuleDocument(RULE_CONTENT);
		// Wrong impl caught: treating hyphen-indented globs lines as body text.
		expect(doc.frontmatter.description).toBe("Keep test suites honest");
		expect(doc.frontmatter.globs).toEqual(["**/*.ts", "**/*.tsx"]);
		expect(doc.frontmatter.alwaysApply).toBe(false);
		expect(doc.body).toBe("body line 1\nbody line 2");
	});

	// SPEC: agent-rule-transform#RC-12 (globs-less frontmatter)
	it("leaves globs and alwaysApply undefined when absent", () => {
		const doc = parseCursorRuleDocument(
			["---", "description: d", "---", "b"].join("\n"),
		);
		// Wrong impl caught: defaulting absent fields to truthy placeholders.
		expect(doc.frontmatter.description).toBe("d");
		expect(doc.frontmatter.globs).toBeUndefined();
		expect(doc.frontmatter.alwaysApply).toBeUndefined();
		expect(doc.body).toBe("b");
	});
});

// ---------------------------------------------------------------------------
// RC-18 — escapeDoubleQuotedToml: backslash, double quote, \n, \r, \t, \b, \f.
// (Single quotes are plain in TOML basic strings and must stay.)
// ---------------------------------------------------------------------------
describe("escapeDoubleQuotedToml", () => {
	// SPEC: agent-rule-transform#RC-18
	it("escapes backslash and double quote", () => {
		// Wrong impl caught: a YAML-style escaper that leaves `"` or `\` raw.
		expect(escapeDoubleQuotedToml('say "hi" \\ there')).toBe(
			'say \\"hi\\" \\\\ there',
		);
	});

	// SPEC: agent-rule-transform#RC-18
	it("escapes newline, CR, tab, backspace, form feed", () => {
		// Wrong impl caught: conversion that drops these chars instead of
		// escaping (e.g. a naive .replace("\n", " ")).
		expect(escapeDoubleQuotedToml("a\nb\rc\td\be\ff")).toBe(
			"a\\nb\\rc\\td\\be\\ff",
		);
	});

	// SPEC: agent-rule-transform#RC-18 (single quote stays literal in a basic
	// string — only the listed five-plus-two characters are escaped)
	it("keeps single quotes literal within a basic string", () => {
		// Wrong impl caught: a TOML literal-string escaper that doubles quotes.
		expect(escapeDoubleQuotedToml("don't")).toBe("don't");
	});
});

// ---------------------------------------------------------------------------
// parseYamlStringList — shared helper for list-shaped frontmatter values. The
// spec (RC-14) requires blank entries to be dropped from list round-trips.
// ---------------------------------------------------------------------------
describe("parseYamlStringList", () => {
	// SPEC: agent-rule-transform#RC-14 (blank entries dropped)
	it("drops blank and whitespace-only lines", () => {
		const raw = ['- "a"', "", '- ""', "   ", '- "b"'].join("\n");
		// Wrong impl caught: filter that keeps blank-only entries.
		expect(parseYamlStringList(raw)).toEqual(["a", "b"]);
	});

	// SPEC: agent-rule-transform#RC-12 (globs parse through the same helper)
	it("parses a block list keeping quoted values unquoted", () => {
		const raw = ['- "**/*.ts"', '- "**/*.tsx"', '  -  "third"'].join("\n");
		// Wrong impl caught: regex that keeps surrounding quotes.
		expect(parseYamlStringList(raw)).toEqual(["**/*.ts", "**/*.tsx", "third"]);
	});

	// SPEC: agent-rule-transform#RC-14 (flow list form)
	it("parses a flow-style list into the same shape", () => {
		// Wrong impl caught: tokenizer that only understands block lists.
		expect(parseYamlStringList('["run", "read"]')).toEqual(["run", "read"]);
	});
});
