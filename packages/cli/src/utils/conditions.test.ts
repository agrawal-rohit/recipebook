import type { Registry } from "@pebbles/core";
import { RegistryConditionKind } from "@pebbles/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockTextInput = vi.fn();
const mockConfirmInput = vi.fn();
const mockSelectInput = vi.fn();
const mockMultiselectInput = vi.fn();

vi.mock("../cli/prompts", () => ({
	textInput: (...args: unknown[]) => mockTextInput(...args),
	confirmInput: (...args: unknown[]) => mockConfirmInput(...args),
	selectInput: (...args: unknown[]) => mockSelectInput(...args),
	multiselectInput: (...args: unknown[]) => mockMultiselectInput(...args),
}));

import {
	captureItemLocalConditionsForPlan,
	captureRequiredConditions,
} from "./conditions";

describe("utils/conditions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockTextInput.mockResolvedValue("Ada");
		mockConfirmInput.mockResolvedValue(true);
		mockSelectInput.mockResolvedValue("typescript");
		mockMultiselectInput.mockResolvedValue(["ios"]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("builds a default handler runtime when none is provided", async () => {
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				authorName: {
					kind: RegistryConditionKind.TEXT,
					required: true,
					label: "Author",
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["authorName"],
				},
			},
		};

		const context = await captureRequiredConditions(
			registry,
			"/tmp/registry.json",
			"/tmp/project",
			["demo"],
		);

		expect(context).toEqual({ authorName: "Ada" });
		expect(mockTextInput).toHaveBeenCalledWith(
			"Author",
			{ required: true },
			undefined,
		);
	});

	it("auto-selects a sole multiselect value without prompting", async () => {
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				tags: {
					kind: RegistryConditionKind.MULTISELECT,
					required: true,
					label: "Tags",
					values: [{ value: "docs", label: "Docs" }],
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["tags"],
				},
			},
		};

		const context = await captureRequiredConditions(
			registry,
			"/tmp/registry.json",
			"/tmp/project",
			["demo"],
		);

		expect(context).toEqual({ tags: ["docs"] });
		expect(mockMultiselectInput).not.toHaveBeenCalled();
	});

	it("skips infer when a non-optional select has a single remaining value", async () => {
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				language: {
					kind: RegistryConditionKind.SELECT,
					required: true,
					label: "Language",
					handler: "conditions/language.ts",
					values: [{ value: "typescript", label: "TypeScript" }],
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					packs: [
						{
							id: "typescript",
							title: "TypeScript",
							source: "r/demo/typescript.json",
							when: { language: "typescript" },
						},
					],
				},
			},
		};

		await expect(
			captureRequiredConditions(
				registry,
				"/tmp/registry.json",
				"/tmp/project",
				["demo"],
			),
		).resolves.toEqual({ language: "typescript" });
		expect(mockSelectInput).not.toHaveBeenCalled();
	});

	it("omits skipped optional text conditions from context", async () => {
		mockTextInput.mockResolvedValue("");
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				coverageThreshold: {
					kind: RegistryConditionKind.TEXT,
					label: "Coverage",
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["coverageThreshold"],
				},
			},
		};

		const context = await captureRequiredConditions(
			registry,
			"/tmp/registry.json",
			"/tmp/project",
			["demo"],
		);

		expect(context).toEqual({});
		expect(mockTextInput).toHaveBeenCalledWith(
			"Coverage",
			{ required: false },
			undefined,
		);
	});

	it("captures optional boolean conditions via Yes/No/None", async () => {
		mockSelectInput.mockResolvedValue("true");
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				enableCi: {
					kind: RegistryConditionKind.BOOLEAN,
					label: "Enable CI",
					default: true,
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["enableCi"],
				},
			},
		};

		await expect(
			captureRequiredConditions(
				registry,
				"/tmp/registry.json",
				"/tmp/project",
				["demo"],
			),
		).resolves.toEqual({ enableCi: true });
		expect(mockSelectInput).toHaveBeenCalledWith(
			"Enable CI",
			expect.any(Object),
			"true",
		);

		mockSelectInput.mockResolvedValue("None");
		const skipRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				enableCi: {
					kind: RegistryConditionKind.BOOLEAN,
					label: "Enable CI",
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["enableCi"],
				},
			},
		};
		await expect(
			captureRequiredConditions(
				skipRegistry,
				"/tmp/registry.json",
				"/tmp/project",
				["demo"],
			),
		).resolves.toEqual({});
	});

	it("omits skipped optional multiselect conditions from context", async () => {
		mockMultiselectInput.mockResolvedValue([]);
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				platforms: {
					kind: RegistryConditionKind.MULTISELECT,
					label: "Platforms",
					values: [
						{ value: "ios", label: "iOS" },
						{ value: "android", label: "Android" },
					],
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["platforms"],
				},
			},
		};

		await expect(
			captureRequiredConditions(
				registry,
				"/tmp/registry.json",
				"/tmp/project",
				["demo"],
			),
		).resolves.toEqual({});
	});

	it("omits skipped optional select conditions from context", async () => {
		mockSelectInput.mockResolvedValue("None");
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				language: {
					kind: RegistryConditionKind.SELECT,
					label: "Language",
					values: [
						{ value: "typescript", label: "TypeScript" },
						{ value: "python", label: "Python" },
					],
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["language"],
				},
			},
		};

		await expect(
			captureRequiredConditions(
				registry,
				"/tmp/registry.json",
				"/tmp/project",
				["demo"],
			),
		).resolves.toEqual({});
	});

	it("rebuilds the install plan after capturing item-local conditions", async () => {
		mockTextInput.mockResolvedValue("45");
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					conditions: {
						coverageThreshold: {
							kind: RegistryConditionKind.TEXT,
							required: true,
							label: "Coverage",
						},
					},
				},
			},
		};

		const result = await captureItemLocalConditionsForPlan(
			registry,
			"/tmp/registry.json",
			["demo"],
			[{ itemId: "demo", sources: ["r/demo.json"] }],
			{},
			{
				projectDir: "/tmp/project",
				isFile: async () => false,
				isDirectory: async () => false,
				readFile: async () => "",
				run: async () => "",
			},
		);

		expect(result.context).toEqual({ coverageThreshold: "45" });
		expect(result.plan).toEqual([{ itemId: "demo", sources: ["r/demo.json"] }]);
	});

	it("uses a schema default when infer handlers are not allowed", async () => {
		mockTextInput.mockResolvedValue("80");
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				coverageThreshold: {
					kind: RegistryConditionKind.TEXT,
					required: true,
					label: "Coverage",
					default: "80",
					handler: "r/missing.handler.js",
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["coverageThreshold"],
				},
			},
		};

		await expect(
			captureRequiredConditions(
				registry,
				"/tmp/registry.json",
				"/tmp/project",
				["demo"],
				{ allowInfer: false },
			),
		).resolves.toEqual({ coverageThreshold: "80" });
		expect(mockTextInput).toHaveBeenCalledWith(
			"Coverage",
			{ required: true },
			"80",
		);
	});

	it("rebuilds the install plan when a local answer matches a pack dependsOn", async () => {
		mockSelectInput.mockResolvedValue("advanced");
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				extra: {
					title: "Extra",
					description: "Extra",
					type: "configuration",
					source: "r/extra.json",
				},
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					conditions: {
						flavor: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Flavor",
							values: [
								{ value: "basic", label: "Basic" },
								{ value: "advanced", label: "Advanced" },
							],
						},
					},
					packs: [
						{
							id: "basic",
							title: "Basic",
							source: "r/demo/basic.json",
							when: { flavor: "basic" },
						},
						{
							id: "advanced",
							title: "Advanced",
							source: "r/demo/advanced.json",
							when: { flavor: "advanced" },
							dependsOn: ["extra"],
						},
					],
				},
			},
		};

		const result = await captureItemLocalConditionsForPlan(
			registry,
			"/tmp/registry.json",
			["demo"],
			[{ itemId: "demo", sources: ["r/demo.json"] }],
			{},
			{
				projectDir: "/tmp/project",
				isFile: async () => false,
				isDirectory: async () => false,
				readFile: async () => "",
				run: async () => "",
			},
		);

		expect(result.context).toEqual({ flavor: "advanced" });
		expect(result.plan.map((node) => node.itemId)).toEqual(["extra", "demo"]);
		expect(result.plan[1]).toMatchObject({
			itemId: "demo",
			packIds: ["advanced"],
		});
	});

	it("rejects an install plan that names an unknown registry item", async () => {
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
				},
			},
		};

		await expect(
			captureItemLocalConditionsForPlan(
				registry,
				"/tmp/registry.json",
				["demo"],
				[{ itemId: "ghost-item", sources: ["r/ghost.json"] }],
				{},
				{
					projectDir: "/tmp/project",
					isFile: async () => false,
					isDirectory: async () => false,
					readFile: async () => "",
					run: async () => "",
				},
			),
		).rejects.toThrow(
			'Install plan references unknown registry item "ghost-item".',
		);
	});

	it("rejects non-required selects that declare None as a value", async () => {
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				language: {
					kind: RegistryConditionKind.SELECT,
					label: "Language",
					values: [
						{ value: "None", label: "None" },
						{ value: "typescript", label: "TypeScript" },
					],
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["language"],
				},
			},
		};

		await expect(
			captureRequiredConditions(
				registry,
				"/tmp/registry.json",
				"/tmp/project",
				["demo"],
			),
		).rejects.toThrow(
			'Condition "language" value "None" is reserved for skipping non-required selects.',
		);
	});

	it("prompts to confirm an inferred select value when detected", async () => {
		mockConfirmInput.mockResolvedValue(true);
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				codingAgentIDE: {
					kind: RegistryConditionKind.SELECT,
					required: true,
					label: "Coding agent",
					default: "cursor",
					values: [
						{ value: "cursor", label: "Cursor" },
						{ value: "claude-code", label: "Claude Code" },
					],
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["codingAgentIDE"],
				},
			},
		};

		const context = await captureRequiredConditions(
			registry,
			"/tmp/registry.json",
			"/tmp/project",
			["demo"],
		);

		expect(context).toEqual({ codingAgentIDE: "cursor" });
		expect(mockConfirmInput).toHaveBeenCalledWith(
			expect.stringContaining("Detected"),
			{},
			true,
		);
		expect(mockSelectInput).not.toHaveBeenCalled();
	});

	it("falls back to full select prompt when user declines inferred select value", async () => {
		mockConfirmInput.mockResolvedValue(false);
		mockSelectInput.mockResolvedValue("claude-code");
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				codingAgentIDE: {
					kind: RegistryConditionKind.SELECT,
					required: true,
					label: "Coding agent",
					default: "cursor",
					values: [
						{ value: "cursor", label: "Cursor" },
						{ value: "claude-code", label: "Claude Code" },
					],
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["codingAgentIDE"],
				},
			},
		};

		const context = await captureRequiredConditions(
			registry,
			"/tmp/registry.json",
			"/tmp/project",
			["demo"],
		);

		expect(context).toEqual({ codingAgentIDE: "claude-code" });
		expect(mockConfirmInput).toHaveBeenCalledWith(
			expect.stringContaining("Detected"),
			{},
			true,
		);
		expect(mockSelectInput).toHaveBeenCalledWith(
			"Coding agent",
			{
				options: [
					{ label: "Cursor", value: "cursor" },
					{ label: "Claude Code", value: "claude-code" },
				],
			},
			"cursor",
		);
	});

	it("confirms an inferred select using the raw value when the option has no label", async () => {
		mockConfirmInput.mockResolvedValue(true);
		const registry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				codingAgentIDE: {
					kind: RegistryConditionKind.SELECT,
					required: true,
					label: "Coding agent",
					default: "cursor",
					values: [
						{ value: "cursor" },
						{ value: "claude-code", label: "Claude Code" },
					],
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["codingAgentIDE"],
				},
			},
		};

		const context = await captureRequiredConditions(
			registry,
			"/tmp/registry.json",
			"/tmp/project",
			["demo"],
		);

		expect(context).toEqual({ codingAgentIDE: "cursor" });
		expect(mockConfirmInput).toHaveBeenCalledWith(
			expect.stringContaining("Detected"),
			{},
			true,
		);
		expect(mockConfirmInput.mock.calls[0]?.[0]).toContain("cursor");
	});
});
