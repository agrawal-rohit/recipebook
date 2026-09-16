import type { Registry } from "@pebbles/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("chalk", () => ({
	default: {
		bold: (text: string) => text,
		cyan: (text: string) => text,
		dim: (text: string) => text,
		grey: (text: string) => text,
		hex: () => (text: string) => text,
	},
}));

const mockMultiselectInput = vi.fn();

vi.mock("../cli/prompts", () => ({
	multiselectInput: (...args: unknown[]) => mockMultiselectInput(...args),
}));

import { listCommand } from "./list";

const DEFAULT_TYPES: NonNullable<Registry["types"]> = {
	component: {
		label: "Components",
		description: "Reusable UI primitives for building interfaces.",
	},
	configuration: {
		label: "Configurations",
		description: "Project workflows and tooling configuration.",
	},
	"agent-instruction": {
		label: "Agent Instructions",
		description: "Instruction files that guide coding agents.",
	},
	"agent-skill": {
		label: "Agent Skills",
		description: "Reusable skills that extend coding agents.",
	},
	subagent: {
		label: "Subagents",
		description: "Specialised agents for focused tasks.",
	},
	template: {
		label: "Templates",
		description: "Starter scaffolds for new projects.",
	},
	theme: {
		label: "Themes",
		description: "Design tokens and styling presets.",
	},
};

function makeItem(
	overrides: Partial<Registry["items"][string]> & {
		id: string;
		type: string;
		title: string;
	},
): Registry["items"][string] {
	const { id, ...rest } = overrides;
	return {
		description: `${overrides.title} description`,
		packs: [
			{
				id: "default",
				title: "Default",
				source: `r/${id}/default.json`,
			},
		],
		...rest,
	};
}

function makeRegistry(
	items: Registry["items"],
	types: Registry["types"] = DEFAULT_TYPES,
): Registry {
	return {
		types,
		items,
	};
}

describe("commands/list", () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		mockMultiselectInput.mockImplementation(
			async (_message, _opts, defaultValues?: string[]) => defaultValues ?? [],
		);
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
	});

	it("lists items filtered by --type, sorted by title", async () => {
		const registry = makeRegistry({
			"theme-z": makeItem({
				id: "theme-z",
				title: "Zebra Theme",
				type: "theme",
			}),
			"theme-a": makeItem({
				id: "theme-a",
				title: "Alpha Theme",
				type: "theme",
			}),
			"component-a": makeItem({
				id: "component-a",
				title: "Alpha Component",
				type: "component",
			}),
		});

		await listCommand(registry, "theme");

		const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(output).toContain("─".repeat(40));
		expect(output).toContain("Themes");
		expect(output).toContain("Design tokens and styling presets.");
		expect(output).toContain("1.");
		expect(output).not.toContain("-1.");
		expect(output).toContain("Alpha Theme");
		expect(output).toContain("Zebra Theme");
		expect(output.indexOf("Alpha Theme")).toBeLessThan(
			output.indexOf("Zebra Theme"),
		);
		expect(output).not.toContain("Alpha Component");
		expect(output).toContain("2 item(s)");
	});

	it("lists items for repeated --type values and comma entries", async () => {
		const registry = makeRegistry({
			"theme-a": makeItem({
				id: "theme-a",
				title: "Alpha Theme",
				type: "theme",
			}),
			"component-a": makeItem({
				id: "component-a",
				title: "Alpha Component",
				type: "component",
			}),
			"template-a": makeItem({
				id: "template-a",
				title: "Alpha Template",
				type: "template",
			}),
		});

		await listCommand(registry, ["theme", "component,template"]);

		const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(output).toContain("Alpha Theme");
		expect(output).toContain("Alpha Component");
		expect(output).toContain("Alpha Template");
		expect(output).toContain("3 item(s)");
	});

	it("lists all types when --type is all", async () => {
		const registry = makeRegistry({
			"theme-a": makeItem({
				id: "theme-a",
				title: "Alpha Theme",
				type: "theme",
			}),
			"component-a": makeItem({
				id: "component-a",
				title: "Alpha Component",
				type: "component",
			}),
		});

		await listCommand(registry, "all");

		const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(output).toContain("Components");
		expect(output).toContain("Themes");
		expect(output).toContain("2 item(s)");
	});

	it("skips allowed types that have no matching registry items", async () => {
		const registry = makeRegistry({
			"theme-a": makeItem({
				id: "theme-a",
				title: "Alpha Theme",
				type: "theme",
			}),
		});

		await listCommand(registry, "all");

		const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(output).not.toContain("Components");
		expect(output).toContain("Themes");
		expect(output).toContain("1 item(s)");
	});

	it("shows pack titles as a suffix", async () => {
		const registry = makeRegistry({
			"theme-a": makeItem({
				id: "theme-a",
				title: "Alpha Theme",
				type: "theme",
				packs: [
					{
						id: "light",
						title: "Light",
						source: "r/theme-a/light.json",
					},
					{
						id: "dark",
						title: "Dark",
						source: "r/theme-a/dark.json",
					},
				],
			}),
		});

		await listCommand(registry, "theme");

		const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(output).toContain("Alpha Theme [Light, Dark]");
	});

	it("omits the pack suffix when an item has no packs", async () => {
		const registry = makeRegistry({
			"theme-a": makeItem({
				id: "theme-a",
				title: "Alpha Theme",
				type: "theme",
				packs: [],
			}),
		});

		await listCommand(registry, "theme");

		const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(output).toContain("Alpha Theme: Alpha Theme description");
		expect(output).not.toContain("Alpha Theme [");
	});

	it("omits the pack suffix when packs are omitted", async () => {
		const registry = makeRegistry({
			"theme-a": makeItem({
				id: "theme-a",
				title: "Alpha Theme",
				type: "theme",
				packs: undefined,
				source: "r/theme-a.json",
			}),
		});

		await listCommand(registry, "theme");

		const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(output).toContain("Alpha Theme: Alpha Theme description");
		expect(output).not.toContain("Alpha Theme [");
	});

	it("prints an empty-state message when no items match", async () => {
		const registry = makeRegistry({
			"theme-a": makeItem({
				id: "theme-a",
				title: "Alpha Theme",
				type: "theme",
			}),
		});

		await listCommand(registry, "component");

		expect(consoleLogSpy).toHaveBeenCalledWith("─".repeat(40));
		expect(consoleLogSpy).toHaveBeenCalledWith(
			"No registry items match the requested types.",
		);
	});

	it("lists the only available type when --type is omitted", async () => {
		const registry = makeRegistry({
			"theme-a": makeItem({
				id: "theme-a",
				title: "Alpha Theme",
				type: "theme",
			}),
		});

		await listCommand(registry);

		expect(mockMultiselectInput).toHaveBeenCalledWith(
			"Which item types should be listed?",
			expect.objectContaining({
				options: expect.arrayContaining([
					{ label: "Themes", value: "theme", hint: expect.any(String) },
				]),
			}),
			Object.keys(DEFAULT_TYPES),
		);
		expect(
			consoleLogSpy.mock.calls.map((call) => call[0]).join("\n"),
		).toContain("Alpha Theme");
	});

	it("lists every type when --type is omitted and multiple types exist", async () => {
		const registry = makeRegistry({
			"theme-a": makeItem({
				id: "theme-a",
				title: "Alpha Theme",
				type: "theme",
			}),
			"component-a": makeItem({
				id: "component-a",
				title: "Alpha Component",
				type: "component",
			}),
		});

		await listCommand(registry);

		expect(mockMultiselectInput).toHaveBeenCalledWith(
			"Which item types should be listed?",
			expect.objectContaining({
				options: expect.arrayContaining([
					{ label: "Components", value: "component", hint: expect.any(String) },
					{ label: "Themes", value: "theme", hint: expect.any(String) },
				]),
			}),
			Object.keys(DEFAULT_TYPES),
		);
		const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(output).toContain("Components");
		expect(output).toContain("Alpha Component");
		expect(output).toContain("Themes");
		expect(output).toContain("Alpha Theme");
		expect(output).toContain("2 item(s)");
	});

	it("uses the prompt selection when --type is omitted", async () => {
		const registry = makeRegistry({
			"theme-a": makeItem({
				id: "theme-a",
				title: "Alpha Theme",
				type: "theme",
			}),
			"component-a": makeItem({
				id: "component-a",
				title: "Alpha Component",
				type: "component",
			}),
		});
		mockMultiselectInput.mockResolvedValueOnce(["theme"]);

		await listCommand(registry);

		const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(output).toContain("Alpha Theme");
		expect(output).not.toContain("Alpha Component");
		expect(output).toContain("1 item(s)");
	});

	it("throws when the type prompt returns no selection", async () => {
		mockMultiselectInput.mockResolvedValueOnce([]);

		await expect(listCommand(makeRegistry({}))).rejects.toThrow(
			"Select at least one item type to list.",
		);
	});

	it("does not prompt when --type is provided", async () => {
		const registry = makeRegistry({
			"theme-a": makeItem({
				id: "theme-a",
				title: "Alpha Theme",
				type: "theme",
			}),
		});

		await listCommand(registry, "theme");

		expect(mockMultiselectInput).not.toHaveBeenCalled();
	});

	it("throws when --type is provided with no type values", async () => {
		await expect(listCommand(makeRegistry({}), "")).rejects.toThrow(
			"--type requires at least one type value.",
		);
		expect(mockMultiselectInput).not.toHaveBeenCalled();
	});

	it("throws when a registry item has an undeclared type", async () => {
		await expect(
			listCommand(
				makeRegistry({
					widget: makeItem({
						id: "widget",
						title: "Widget",
						type: "ghost",
					}),
				}),
				"theme",
			),
		).rejects.toThrow('Registry item "widget" has undeclared type "ghost".');
		expect(mockMultiselectInput).not.toHaveBeenCalled();
	});

	it("throws when a catalog type has no definition", async () => {
		await expect(
			listCommand(
				makeRegistry(
					{
						"theme-a": makeItem({
							id: "theme-a",
							title: "Alpha Theme",
							type: "theme",
						}),
					},
					{
						theme: undefined as unknown as Registry["types"][string],
					},
				),
				"theme",
			),
		).rejects.toThrow('Registry item type "theme" is not declared.');
	});

	it('throws when the catalog declares type "all"', async () => {
		await expect(
			listCommand(
				makeRegistry(
					{},
					{
						all: { label: "All" },
					},
				),
			),
		).rejects.toThrow(
			'Registry item type "all" is reserved for the --type all filter.',
		);
		expect(mockMultiselectInput).not.toHaveBeenCalled();
	});

	it("throws when no registry item types are available", async () => {
		await expect(listCommand(makeRegistry({}, {}))).rejects.toThrow(
			"No registry item types found.",
		);
	});

	it('throws when combining "all" with specific types', async () => {
		await expect(
			listCommand(
				makeRegistry({}, { theme: { label: "Themes" } }),
				"all,theme",
			),
		).rejects.toThrow('Cannot combine type "all" with specific --type values.');
	});

	it("throws for unsupported --type values", async () => {
		await expect(
			listCommand(
				makeRegistry(
					{},
					{
						theme: { label: "Themes" },
						component: { label: "Components" },
					},
				),
				"workflow",
			),
		).rejects.toThrow(
			'Unsupported registry type "workflow" (available: theme, component).',
		);
	});

	it("formats labels from registry.types", async () => {
		const registry = makeRegistry({
			component: makeItem({
				id: "component",
				title: "Component",
				type: "component",
			}),
			configuration: makeItem({
				id: "configuration",
				title: "Configuration",
				type: "configuration",
			}),
			"agent-instruction": makeItem({
				id: "agent-instruction",
				title: "Agent Instruction",
				type: "agent-instruction",
			}),
			"agent-skill": makeItem({
				id: "agent-skill",
				title: "Agent Skill",
				type: "agent-skill",
			}),
			subagent: makeItem({
				id: "subagent",
				title: "Subagent",
				type: "subagent",
			}),
			template: makeItem({
				id: "template",
				title: "Template",
				type: "template",
			}),
			theme: makeItem({
				id: "theme",
				title: "Theme",
				type: "theme",
			}),
		});

		await listCommand(registry, "all");

		const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(output).toContain("Components");
		expect(output).toContain("Configurations");
		expect(output).toContain("Agent Instructions");
		expect(output).toContain("Agent Skills");
		expect(output).toContain("Subagents");
		expect(output).toContain("Templates");
		expect(output).toContain("Themes");
		expect(output).toContain("7 item(s)");
	});

	it("falls back to the raw type string when type metadata has no label", async () => {
		const registry = makeRegistry(
			{
				"theme-a": makeItem({
					id: "theme-a",
					title: "Alpha Theme",
					type: "theme",
				}),
			},
			{
				theme: {
					label: undefined as unknown as string,
				},
			},
		);

		await listCommand(registry, "theme");

		const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
		expect(output).toContain("theme");
		expect(output).toContain("Alpha Theme");
	});

	it("omits the type hint in the prompt when metadata has no description", async () => {
		const registry = makeRegistry(
			{
				"theme-a": makeItem({
					id: "theme-a",
					title: "Alpha Theme",
					type: "theme",
				}),
			},
			{
				theme: { label: "Themes" },
			},
		);

		await listCommand(registry);

		expect(mockMultiselectInput).toHaveBeenCalledWith(
			"Which item types should be listed?",
			{
				options: [{ label: "Themes", value: "theme" }],
			},
			["theme"],
		);
	});

	it("uses the raw type as the prompt label when metadata has no label", async () => {
		const registry = makeRegistry(
			{
				"theme-a": makeItem({
					id: "theme-a",
					title: "Alpha Theme",
					type: "theme",
				}),
			},
			{
				theme: {
					label: undefined as unknown as string,
					description: "Design tokens",
				},
			},
		);

		await listCommand(registry);

		expect(mockMultiselectInput).toHaveBeenCalledWith(
			"Which item types should be listed?",
			{
				options: [{ label: "theme", value: "theme", hint: "Design tokens" }],
			},
			["theme"],
		);
	});
});
