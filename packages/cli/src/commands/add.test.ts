import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Registry, RegistryConditionKind } from "@cheetos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockMultiselectInput = vi.fn();
const mockGroupedSelectInput = vi.fn();
const mockSelectInput = vi.fn();
const mockConfirmInput = vi.fn();
const mockTextInput = vi.fn();
const mockBuildInstallPlan = vi.fn();
const mockLoadCompiledItems = vi.fn();
const mockWriteFileAsync = vi.fn();
const mockIsFileAsync = vi.fn();
const mockRunAsync = vi.fn();
const mockRunArgvAsync = vi.fn();
const mockRunWithTasks = vi.fn();
const mockPrepareScriptExecution = vi.fn(async (..._args: unknown[]) => ({
	trust: "bundled",
	allowInfer: true,
	allowMutation: true,
}));

vi.mock("../cli/tasks", async () => {
	const actual =
		await vi.importActual<typeof import("../cli/tasks")>("../cli/tasks");
	return {
		...actual,
		runWithTasks: (...args: unknown[]) => mockRunWithTasks(...args),
	};
});

vi.mock("../cli/prompts", () => ({
	multiselectInput: (...args: unknown[]) => mockMultiselectInput(...args),
	groupedSelectInput: (...args: unknown[]) => mockGroupedSelectInput(...args),
	selectInput: (...args: unknown[]) => mockSelectInput(...args),
	confirmInput: (...args: unknown[]) => mockConfirmInput(...args),
	textInput: (...args: unknown[]) => mockTextInput(...args),
}));

vi.mock("../utils/registry", () => ({
	loadCompiledItems: (...args: unknown[]) => mockLoadCompiledItems(...args),
	bundledRegistryPath: () => "/bundled/registry.json",
}));

vi.mock("../utils/scripts", async () => {
	const actual =
		await vi.importActual<typeof import("../utils/scripts")>(
			"../utils/scripts",
		);
	return {
		...actual,
		prepareScriptExecution: (...args: unknown[]) =>
			mockPrepareScriptExecution(...args),
	};
});

vi.mock("@cheetos/core", async () => {
	const actual =
		await vi.importActual<typeof import("@cheetos/core")>("@cheetos/core");
	return {
		...actual,
		buildInstallPlan: (...args: unknown[]) => mockBuildInstallPlan(...args),
		writeFileAsync: (...args: unknown[]) => mockWriteFileAsync(...args),
		isFileAsync: (...args: unknown[]) => mockIsFileAsync(...args),
		runAsync: (...args: unknown[]) => mockRunAsync(...args),
		runArgvAsync: (...args: unknown[]) => mockRunArgvAsync(...args),
	};
});

import { addCommand } from "./add";

function makeRegistry(): Registry {
	return {
		types: { configuration: { label: "Configurations" } },
		conditions: {
			language: {
				required: true,
				kind: RegistryConditionKind.SELECT,
				label: "Language",
				values: [{ value: "typescript", label: "TypeScript" }],
			},
		},
		items: {
			"pr-template-configuration": {
				title: "Pull Request Template",
				description: "PR template",
				type: "configuration",
				source: "r/pr-template-configuration.json",
			},
		},
	};
}

describe("commands/add", () => {
	let tempDir: string;
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	const registry = makeRegistry();
	const indexLocation = "/workspace/registry.json";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-command-"));
		fs.writeFileSync(path.join(tempDir, "pnpm-lock.yaml"), "");
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.clearAllMocks();

		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "pr-template-configuration",
				sources: ["r/pr-template-configuration.json"],
			},
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/pr-template-configuration.json",
					{
						files: [
							{
								target: ".github/pull_request_template.md",
								content: "# PR Template",
							},
						],
					},
				],
			]),
		);
		mockIsFileAsync.mockResolvedValue(false);
		mockWriteFileAsync.mockResolvedValue(undefined);
		mockConfirmInput.mockResolvedValue(false);
		mockPrepareScriptExecution.mockResolvedValue({
			trust: "bundled",
			allowInfer: true,
			allowMutation: true,
		});
		mockRunWithTasks.mockImplementation(
			async (
				_goal: string,
				work:
					| (() => Promise<void>)
					| Array<{
							task?: () => Promise<void>;
							subtasks?: unknown[];
					  }>,
			) => {
				const runSubs = async (
					nodes?: Array<{
						task?: () => Promise<void>;
						subtasks?: unknown[];
					}>,
				) => {
					for (const node of nodes ?? []) {
						if (node.task) await node.task();
						await runSubs(
							node.subtasks as Array<{
								task?: () => Promise<void>;
								subtasks?: unknown[];
							}>,
						);
					}
				};
				if (typeof work === "function") await work();
				else await runSubs(work);
			},
		);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("asks script permission for selected items and their dependsOn closure", async () => {
		const dependentRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				base: {
					title: "Base",
					description: "Dependency",
					type: "configuration",
					source: "r/base.json",
					beforeWrite: ["r/base.beforeWrite.0.js"],
				},
				"pr-template-configuration": {
					title: "Pull Request Template",
					description: "PR template",
					type: "configuration",
					source: "r/pr-template-configuration.json",
					dependsOn: ["base"],
				},
			},
		};

		await addCommand(dependentRegistry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		expect(mockPrepareScriptExecution).toHaveBeenCalledWith(
			expect.objectContaining({
				itemIds: ["pr-template-configuration", "base"],
			}),
		);
	});

	it("re-walks candidates when the selected package manager drops pack dependsOn", async () => {
		const packRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				"eslint-npm": {
					title: "ESLint for npm",
					description: "npm-only eslint pack dependency",
					type: "configuration",
					source: "r/eslint-npm.json",
				},
				tooling: {
					title: "Tooling",
					description: "Tooling with package-manager packs",
					type: "configuration",
					source: "r/tooling.json",
					packs: [
						{
							id: "npm",
							title: "npm",
							source: "r/tooling.npm.json",
							when: { packageManager: "npm" },
							dependsOn: ["eslint-npm"],
						},
					],
				},
			},
		};

		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "tooling",
				sources: ["r/tooling.json"],
			},
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/tooling.json",
					{ files: [{ target: "tooling.txt", content: "tooling" }] },
				],
			]),
		);

		await addCommand(packRegistry, indexLocation, {
			items: ["tooling"],
			overwrite: true,
		});

		expect(mockPrepareScriptExecution).toHaveBeenCalledWith(
			expect.objectContaining({
				itemIds: ["tooling"],
				packageManager: "pnpm",
			}),
		);
		expect(mockPrepareScriptExecution).not.toHaveBeenCalledWith(
			expect.objectContaining({
				itemIds: expect.arrayContaining(["eslint-npm"]),
			}),
		);
		expect(mockBuildInstallPlan).toHaveBeenCalledWith(
			["tooling"],
			packRegistry.items,
			expect.anything(),
			"pnpm",
		);
		expect(mockLoadCompiledItems).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.arrayContaining(["r/eslint-npm.json"]),
			expect.anything(),
		);
	});

	it("narrows script permission to pinned pack dependencies", async () => {
		const packRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				language: {
					required: true,
					kind: RegistryConditionKind.SELECT,
					label: "Language",
					values: [
						{ value: "typescript", label: "TypeScript" },
						{ value: "python", label: "Python" },
					],
				},
			},
			items: {
				"typescript-base": {
					title: "TypeScript base",
					description: "TS dependency",
					type: "configuration",
					source: "r/typescript-base.json",
					beforeWrite: ["r/typescript-base.beforeWrite.0.js"],
				},
				"python-base": {
					title: "Python base",
					description: "Python dependency",
					type: "configuration",
					source: "r/python-base.json",
					beforeWrite: ["r/python-base.beforeWrite.0.js"],
				},
				release: {
					title: "Release",
					description: "Release workflow",
					type: "configuration",
					source: "r/release.json",
					packs: [
						{
							id: "typescript",
							title: "TypeScript",
							source: "r/release.typescript.json",
							when: { language: "typescript" },
							dependsOn: ["typescript-base"],
						},
						{
							id: "python",
							title: "Python",
							source: "r/release.python.json",
							when: { language: "python" },
							dependsOn: ["python-base"],
						},
					],
				},
			},
		};

		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "typescript-base",
				sources: ["r/typescript-base.json"],
			},
			{
				itemId: "release",
				packIds: ["typescript"],
				sources: ["r/release.json", "r/release.typescript.json"],
			},
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/typescript-base.json",
					{ files: [{ target: "ts-base.txt", content: "ts" }] },
				],
				[
					"r/release.json",
					{ files: [{ target: "release.txt", content: "release" }] },
				],
				[
					"r/release.typescript.json",
					{ files: [{ target: "release-ts.txt", content: "ts pack" }] },
				],
			]),
		);

		await addCommand(packRegistry, indexLocation, {
			items: ["release@typescript"],
			overwrite: true,
		});

		expect(mockPrepareScriptExecution).toHaveBeenCalledWith(
			expect.objectContaining({
				itemIds: ["release", "typescript-base"],
			}),
		);
		expect(mockSelectInput).not.toHaveBeenCalledWith(
			"Language",
			expect.anything(),
			expect.anything(),
		);
	});

	it("installs a positional item and writes compiled item files", async () => {
		await expect(
			addCommand(registry, indexLocation, {
				items: ["pr-template-configuration"],
			}),
		).resolves.toBeUndefined();

		expect(mockMultiselectInput).not.toHaveBeenCalled();
		expect(mockLoadCompiledItems).toHaveBeenCalledWith(
			indexLocation,
			["r/pr-template-configuration.json"],
			undefined,
		);
		expect(mockRunWithTasks).toHaveBeenCalledWith(
			"Preparing changes",
			expect.any(Function),
		);
		expect(mockWriteFileAsync).toHaveBeenCalledWith(
			path.join(tempDir, ".github/pull_request_template.md"),
			"# PR Template",
		);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining("Installed 1 item."),
		);
		expect(consoleLogSpy).not.toHaveBeenCalledWith(
			expect.stringContaining("Registry items installed successfully!"),
		);
	});

	it("prompts for items grouped by type when none are provided", async () => {
		mockGroupedSelectInput.mockResolvedValue("pr-template-configuration");

		await addCommand(registry, indexLocation, {});

		expect(mockGroupedSelectInput).toHaveBeenCalledWith(
			"Which registry item should be added?",
			{
				Configurations: [
					{
						label: "Pull Request Template",
						value: "pr-template-configuration",
						hint: "PR template",
					},
				],
			},
		);
		expect(mockWriteFileAsync).toHaveBeenCalled();
	});

	it("passes the item title to the grouped prompt", async () => {
		const packedRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				"pr-template-configuration": {
					title: "Pull Request Template",
					description: "PR template",
					type: "configuration",
					packs: [
						{
							id: "light",
							title: "Light",
							when: {},
							source: "r/pr/light.json",
						},
						{ id: "dark", title: "Dark", when: {}, source: "r/pr/dark.json" },
					],
				},
			},
		};
		mockGroupedSelectInput.mockResolvedValue("pr-template-configuration");
		mockBuildInstallPlan.mockReturnValue([
			{ itemId: "pr-template-configuration", sources: ["r/pr/light.json"] },
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([["r/pr/light.json", { files: [] }]]),
		);

		await addCommand(packedRegistry, indexLocation, {});

		const [, groupedOptions] = mockGroupedSelectInput.mock.calls[0] as [
			string,
			Record<string, Array<{ label: string; value: string; hint?: string }>>,
		];
		expect(groupedOptions).toEqual({
			Configurations: [
				{
					label: "Pull Request Template",
					value: "pr-template-configuration",
					hint: "PR template",
				},
			],
		});
	});

	it("prompts when items is an empty array", async () => {
		mockGroupedSelectInput.mockResolvedValue("pr-template-configuration");

		await addCommand(registry, indexLocation, { items: [] });

		expect(mockGroupedSelectInput).toHaveBeenCalled();
	});

	it("sorts grouped prompt options by title", async () => {
		const sortedRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				"zebra-configuration": {
					title: "Zebra Template",
					description: "Z",
					type: "configuration",
					source: "r/zebra.json",
				},
				"alpha-configuration": {
					title: "Alpha Template",
					description: "A",
					type: "configuration",
					source: "r/alpha.json",
				},
			},
		};
		mockGroupedSelectInput.mockResolvedValue("alpha-configuration");
		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "alpha-configuration",
				sources: ["r/alpha.json"],
			},
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([["r/alpha.json", { files: [] }]]),
		);

		await addCommand(sortedRegistry, indexLocation, {});

		expect(mockGroupedSelectInput).toHaveBeenCalledWith(
			"Which registry item should be added?",
			{
				Configurations: [
					{
						label: "Alpha Template",
						value: "alpha-configuration",
						hint: "A",
					},
					{
						label: "Zebra Template",
						value: "zebra-configuration",
						hint: "Z",
					},
				],
			},
		);
	});

	it("places every type in one grouped prompt", async () => {
		const groupedRegistry: Registry = {
			types: {
				configuration: { label: "Configurations" },
				workflow: { label: "Workflows" },
			},
			items: {
				"code-quality-workflow": {
					title: "Code Quality",
					description: "CI workflow",
					type: "workflow",
					source: "r/code-quality-workflow.json",
				},
				"pr-template-configuration": {
					title: "Pull Request Template",
					description: "PR template",
					type: "configuration",
					source: "r/pr-template-configuration.json",
				},
			},
		};
		mockGroupedSelectInput.mockResolvedValue("pr-template-configuration");
		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "pr-template-configuration",
				sources: ["r/pr-template-configuration.json"],
			},
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/pr-template-configuration.json",
					{
						files: [
							{
								target: ".github/pull_request_template.md",
								content: "# PR Template",
							},
						],
					},
				],
				[
					"r/code-quality-workflow.json",
					{
						files: [
							{
								target: ".github/workflows/code-quality.yml",
								content: "name: quality",
							},
						],
					},
				],
			]),
		);

		await addCommand(groupedRegistry, indexLocation, {});

		expect(mockGroupedSelectInput).toHaveBeenCalledTimes(1);
		expect(mockGroupedSelectInput).toHaveBeenCalledWith(
			"Which registry item should be added?",
			{
				Configurations: [
					expect.objectContaining({ value: "pr-template-configuration" }),
				],
				Workflows: [
					expect.objectContaining({ value: "code-quality-workflow" }),
				],
			},
		);
		expect(mockBuildInstallPlan).toHaveBeenCalledWith(
			["pr-template-configuration"],
			groupedRegistry.items,
			{},
			undefined,
		);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining("Installed 1 item."),
		);
	});

	it("prompts before overwriting an existing file unless --overwrite is set", async () => {
		const existing = path.join(tempDir, ".github/pull_request_template.md");
		fs.mkdirSync(path.dirname(existing), { recursive: true });
		fs.writeFileSync(existing, "existing\n");
		mockConfirmInput.mockResolvedValueOnce(false);

		await expect(
			addCommand(registry, indexLocation, {
				items: ["pr-template-configuration"],
			}),
		).rejects.toThrow("Installation canceled before overwriting");

		mockConfirmInput.mockResolvedValueOnce(true);

		await addCommand(registry, indexLocation, {
			items: ["pr-template-configuration"],
		});

		await addCommand(registry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		expect(mockConfirmInput).toHaveBeenCalledTimes(2);
		expect(mockWriteFileAsync).toHaveBeenCalledTimes(2);
	});

	it("rejects when a compiled item target exists as a directory", async () => {
		const targetDir = path.join(tempDir, ".github/pull_request_template.md");
		fs.mkdirSync(targetDir, { recursive: true });

		await expect(
			addCommand(registry, indexLocation, {
				items: ["pr-template-configuration"],
				overwrite: true,
			}),
		).rejects.toThrow("exists and is a directory");
	});

	it("auto-selects a sole select condition option without prompting", async () => {
		const conditionRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				language: {
					label: "Language",
					kind: RegistryConditionKind.SELECT,
					required: true,
					values: [{ value: "typescript", label: "TypeScript" }],
				},
			},
			items: {
				"pr-template-configuration": {
					title: "Pull Request Template",
					description: "PR template",
					type: "configuration",
					source: "r/pr-template-configuration.json",
					packs: [
						{
							id: "ts",
							title: "TypeScript",
							source: "r/pr-template-configuration.json",
							when: { language: "typescript" },
						},
					],
				},
			},
		};

		await addCommand(conditionRegistry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		expect(mockSelectInput).not.toHaveBeenCalled();
		expect(mockWriteFileAsync).toHaveBeenCalled();
	});

	it("rejects a missing payload document", async () => {
		mockLoadCompiledItems.mockResolvedValue(new Map());

		await expect(
			addCommand(registry, indexLocation, {
				items: ["pr-template-configuration"],
				overwrite: true,
			}),
		).rejects.toThrow(
			'Missing compiled item for registry item "pr-template-configuration"',
		);
	});

	it("rejects an empty registry when prompting for items", async () => {
		await expect(
			addCommand(
				{ types: { configuration: { label: "Configurations" } }, items: {} },
				indexLocation,
				{},
			),
		).rejects.toThrow("No registry items are available.");
	});

	it("omits undeclared-type items from the item prompt (core parse-time validation rejects them first)", async () => {
		// The real groupedSelectInput fails fast on an empty options map; mirror that.
		mockGroupedSelectInput.mockRejectedValue(
			new Error(
				'Select prompt "Which registry item should be added?" has no options.',
			),
		);
		await expect(
			addCommand(
				{
					types: { configuration: { label: "Configurations" } },
					items: {
						widget: {
							title: "Widget",
							description: "A widget",
							type: "component",
							source: "r/widget.json",
						},
					},
				},
				indexLocation,
				{},
			),
		).rejects.toThrow(
			'Select prompt "Which registry item should be added?" has no options.',
		);
		expect(mockGroupedSelectInput).toHaveBeenCalledWith(
			"Which registry item should be added?",
			{},
		);
	});

	it("rejects a positional item that is not in the registry", async () => {
		await expect(
			addCommand(registry, indexLocation, { items: ["missing"] }),
		).rejects.toThrow('Registry item not found: "missing"');
		expect(mockPrepareScriptExecution).not.toHaveBeenCalled();
	});

	it("rejects when more than one item id is passed", async () => {
		await expect(
			addCommand(registry, indexLocation, {
				items: ["pr-template-configuration", "code-quality-workflow"],
			}),
		).rejects.toThrow(
			"add installs one registry item at a time; pass a single item id.",
		);
		expect(mockPrepareScriptExecution).not.toHaveBeenCalled();
	});

	it("rejects a positional pack pin that the item does not declare", async () => {
		await expect(
			addCommand(registry, indexLocation, {
				items: ["pr-template-configuration@typescript"],
			}),
		).rejects.toThrow(
			'Registry item "pr-template-configuration" has no packs.',
		);
		expect(mockPrepareScriptExecution).not.toHaveBeenCalled();
	});

	it("omits empty type groups when prompting for items", async () => {
		const sparseRegistry: Registry = {
			types: {
				configuration: { label: "Configurations" },
				workflow: { label: "Workflows" },
			},
			items: {
				"pr-template-configuration": {
					title: "Pull Request Template",
					description: "PR template",
					type: "configuration",
					source: "r/pr-template-configuration.json",
				},
			},
		};
		mockGroupedSelectInput.mockResolvedValue("pr-template-configuration");

		await addCommand(sparseRegistry, indexLocation, {});

		expect(mockGroupedSelectInput).toHaveBeenCalledWith(
			"Which registry item should be added?",
			{
				Configurations: [
					expect.objectContaining({ value: "pr-template-configuration" }),
				],
			},
		);
	});

	it("prompts for text, boolean, select, and multiselect conditions", async () => {
		const conditionRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				authorName: {
					kind: RegistryConditionKind.TEXT,
					required: true,
					label: "Author",
					description: "Your name",
				},
				enableCi: {
					kind: RegistryConditionKind.BOOLEAN,
					required: true,
					label: "Enable CI",
				},
				language: {
					kind: RegistryConditionKind.SELECT,
					required: true,
					label: "Language",
					values: [
						{ value: "typescript", label: "TypeScript" },
						{ value: "javascript", label: "JavaScript" },
					],
				},
				platforms: {
					kind: RegistryConditionKind.MULTISELECT,
					required: true,
					label: "Platforms",
					values: [
						{ value: "ios", label: "iOS" },
						{ value: "android", label: "Android" },
					],
				},
			},
			items: {
				"pr-template-configuration": {
					title: "Pull Request Template",
					description: "PR template",
					type: "configuration",
					source: "r/pr-template-configuration.json",
					requires: ["authorName", "enableCi", "language", "platforms"],
				},
			},
		};
		mockTextInput.mockResolvedValue("Ada");
		mockConfirmInput.mockResolvedValue(true);
		mockSelectInput.mockResolvedValue("typescript");
		mockMultiselectInput.mockResolvedValue(["ios"]);

		await addCommand(conditionRegistry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		expect(mockTextInput).toHaveBeenCalledWith(
			"Your name",
			{ required: true },
			undefined,
		);
		expect(mockConfirmInput).toHaveBeenCalledWith("Enable CI", {}, undefined);
		expect(mockSelectInput).toHaveBeenCalledWith(
			"Language",
			{
				options: [
					{ label: "TypeScript", value: "typescript" },
					{ label: "JavaScript", value: "javascript" },
				],
			},
			undefined,
		);
		expect(mockMultiselectInput).toHaveBeenCalledWith(
			"Platforms",
			{
				options: [
					{ label: "iOS", value: "ios" },
					{ label: "Android", value: "android" },
				],
			},
			undefined,
		);
	});

	it("auto-selects a sole multiselect option and seeds defaults from inferred values", async () => {
		const handlerDir = fs.mkdtempSync(path.join(os.tmpdir(), "cond-handler-"));
		const catalogPath = path.join(handlerDir, "registry.json");
		const multiHandler = path.join(
			handlerDir,
			"r/_handlers/platforms.handler.js",
		);
		const selectHandler = path.join(
			handlerDir,
			"r/_handlers/language.handler.js",
		);
		fs.mkdirSync(path.dirname(multiHandler), { recursive: true });
		fs.writeFileSync(catalogPath, "{}\n");
		fs.writeFileSync(
			multiHandler,
			"module.exports = { async infer() { return ['ios']; } };\n",
		);
		fs.writeFileSync(
			selectHandler,
			"module.exports = { async infer() { return 'typescript'; } };\n",
		);

		const conditionRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				tags: {
					kind: RegistryConditionKind.MULTISELECT,
					required: true,
					label: "Tags",
					values: [{ value: "docs", label: "Docs" }],
				},
				platforms: {
					kind: RegistryConditionKind.MULTISELECT,
					required: true,
					label: "Platforms",
					handler: "r/_handlers/platforms.handler.js",
					values: [
						{ value: "ios", label: "iOS" },
						{ value: "android", label: "Android" },
					],
				},
				language: {
					kind: RegistryConditionKind.SELECT,
					required: true,
					label: "Language",
					handler: "r/_handlers/language.handler.js",
					values: [
						{ value: "typescript", label: "TypeScript" },
						{ value: "javascript", label: "JavaScript" },
					],
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo item",
					type: "configuration",
					source: "r/pr-template-configuration.json",
					requires: ["tags", "platforms", "language"],
				},
			},
		};

		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "demo",
				sources: ["r/pr-template-configuration.json"],
			},
		]);
		mockMultiselectInput.mockResolvedValue(["ios"]);
		mockSelectInput.mockResolvedValue("typescript");

		try {
			await addCommand(conditionRegistry, catalogPath, {
				items: ["demo"],
				overwrite: true,
			});

			expect(mockMultiselectInput).toHaveBeenCalledWith(
				"Platforms",
				expect.any(Object),
				["ios"],
			);
			expect(mockMultiselectInput).not.toHaveBeenCalledWith(
				"Tags",
				expect.anything(),
				expect.anything(),
			);
			expect(mockSelectInput).toHaveBeenCalledWith(
				"Language",
				expect.any(Object),
				"typescript",
			);
		} finally {
			fs.rmSync(handlerDir, { recursive: true, force: true });
		}
	});

	it("seeds text and boolean prompt defaults from condition handlers", async () => {
		const handlerDir = fs.mkdtempSync(path.join(os.tmpdir(), "cond-tb-"));
		const catalogPath = path.join(handlerDir, "registry.json");
		const textHandler = path.join(
			handlerDir,
			"r/_handlers/authorName.handler.js",
		);
		const boolHandler = path.join(
			handlerDir,
			"r/_handlers/enableCi.handler.js",
		);
		fs.mkdirSync(path.dirname(textHandler), { recursive: true });
		fs.writeFileSync(catalogPath, "{}\n");
		fs.writeFileSync(
			textHandler,
			`
module.exports = {
  async infer(ctx) {
    await ctx.run("true");
    return "Ada";
  },
};
`,
		);
		fs.writeFileSync(
			boolHandler,
			"module.exports = { async infer() { return true; } };\n",
		);

		const conditionRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				authorName: {
					kind: RegistryConditionKind.TEXT,
					required: true,
					label: "Author",
					handler: "r/_handlers/authorName.handler.js",
				},
				enableCi: {
					kind: RegistryConditionKind.BOOLEAN,
					required: true,
					label: "Enable CI",
					handler: "r/_handlers/enableCi.handler.js",
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo item",
					type: "configuration",
					source: "r/pr-template-configuration.json",
					requires: ["authorName", "enableCi"],
				},
			},
		};

		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "demo",
				sources: ["r/pr-template-configuration.json"],
			},
		]);
		mockTextInput.mockResolvedValue("Ada");
		mockConfirmInput.mockResolvedValue(true);

		try {
			await addCommand(conditionRegistry, catalogPath, {
				items: ["demo"],
				overwrite: true,
			});

			expect(mockRunAsync).toHaveBeenCalledWith(
				"true",
				expect.objectContaining({ cwd: tempDir, stdio: "pipe" }),
			);
			expect(mockTextInput).toHaveBeenCalledWith(
				"Author",
				{ required: true },
				"Ada",
			);
			expect(mockConfirmInput).toHaveBeenCalledWith("Enable CI", {}, true);
		} finally {
			fs.rmSync(handlerDir, { recursive: true, force: true });
		}
	});

	it("ignores empty package maps that merge to nothing", async () => {
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/pr-template-configuration.json",
					{
						files: [
							{
								target: ".github/pull_request_template.md",
								content: "# PR Template",
							},
						],
						dependencies: {
							npm: {
								runtime: [],
								dev: [],
							},
						},
					},
				],
			]),
		);
		mockConfirmInput.mockResolvedValue(true);

		await addCommand(registry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		expect(mockSelectInput).not.toHaveBeenCalled();
		expect(mockRunAsync).not.toHaveBeenCalled();
		expect(consoleLogSpy).not.toHaveBeenCalledWith(
			expect.stringContaining("Next steps"),
		);
	});

	it("falls back to the item id when the index has no title", async () => {
		const untitledRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				"untitled-item": {
					title: undefined as unknown as string,
					description: "No title",
					type: "configuration",
					source: "r/pr-template-configuration.json",
				},
			},
		};
		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "untitled-item",
				sources: ["r/pr-template-configuration.json"],
			},
		]);

		await addCommand(untitledRegistry, indexLocation, {
			items: ["untitled-item"],
			overwrite: true,
		});

		expect(mockRunWithTasks).toHaveBeenCalledWith(
			"Adding item content",
			expect.arrayContaining([
				expect.objectContaining({
					title: expect.stringContaining("untitled-item"),
				}),
			]),
		);
	});

	it("rejects an install plan that names an unknown registry item", async () => {
		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "ghost-item",
				sources: ["r/pr-template-configuration.json"],
			},
		]);

		await expect(
			addCommand(registry, indexLocation, {
				items: ["pr-template-configuration"],
				overwrite: true,
			}),
		).rejects.toThrow(
			'Install plan references unknown registry item "ghost-item".',
		);
	});

	it("throws when the install plan contains no items", async () => {
		mockBuildInstallPlan.mockReturnValue([]);

		await expect(
			addCommand(registry, indexLocation, {
				items: ["pr-template-configuration"],
			}),
		).rejects.toThrow("No registry item was selected for installation.");
	});

	it("passes packIds into beforeWrite scripts when present", async () => {
		const handlerDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-variant-"));
		const catalogPath = path.join(handlerDir, "registry.json");
		const scriptPath = path.join(handlerDir, "r/hello.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(catalogPath, "{}\n");
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite(ctx) {
  return {
    files: [{ target: "VARIANT.md", content: (ctx.packIds || []).join(",") || "none" }],
  };
};
`,
		);

		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "hello",
				packIds: ["typescript"],
				beforeWriteScripts: ["r/hello.beforeWrite.0.js"],
			},
		]);

		const handlerRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				hello: {
					title: "Hello",
					description: "Install script demo",
					type: "configuration",
					beforeWrite: ["r/hello.beforeWrite.0.js"],
				},
			},
		};

		try {
			await addCommand(handlerRegistry, catalogPath, {
				items: ["hello"],
				overwrite: true,
			});

			expect(mockWriteFileAsync).toHaveBeenCalledWith(
				path.join(tempDir, "VARIANT.md"),
				"typescript",
			);
		} finally {
			fs.rmSync(handlerDir, { recursive: true, force: true });
		}
	});

	it("passes packIds into afterInstall scripts when present", async () => {
		const handlerDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "add-after-variant-"),
		);
		const catalogPath = path.join(handlerDir, "registry.json");
		const logPath = path.join(tempDir, "after-variant.log");
		const scriptPath = path.join(handlerDir, "r/hello.afterInstall.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(catalogPath, "{}\n");
		fs.writeFileSync(
			scriptPath,
			`
const fs = require("node:fs");
module.exports = async function afterInstall(ctx) {
  fs.appendFileSync(${JSON.stringify(logPath)}, (ctx.packIds || []).join(",") || "none");
};
`,
		);

		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "hello",
				packIds: ["typescript"],
				sources: ["r/hello.json"],
				afterInstallScripts: ["r/hello.afterInstall.0.js"],
			},
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/hello.json",
					{
						files: [{ target: "DONE.txt", content: "ok" }],
					},
				],
			]),
		);

		const handlerRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				hello: {
					title: "Hello",
					description: "After-install script demo",
					type: "configuration",
					source: "r/hello.json",
					afterInstall: ["r/hello.afterInstall.0.js"],
				},
			},
		};

		try {
			await addCommand(handlerRegistry, catalogPath, {
				items: ["hello"],
				overwrite: true,
			});

			expect(fs.readFileSync(logPath, "utf8")).toBe("typescript");
		} finally {
			fs.rmSync(handlerDir, { recursive: true, force: true });
		}
	});

	it("rejects an invalid compiled item from fetch", async () => {
		mockLoadCompiledItems.mockRejectedValue(
			new Error(
				'Compiled item "r/pr-template-configuration.json" has an unknown key: extra.',
			),
		);

		await expect(
			addCommand(registry, indexLocation, {
				items: ["pr-template-configuration"],
				overwrite: true,
			}),
		).rejects.toThrow('Compiled item "r/pr-template-configuration.json"');
	});

	it("rejects path traversal in compiled item targets", async () => {
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/pr-template-configuration.json",
					{
						files: [{ target: "../escape.txt", content: "nope" }],
					},
				],
			]),
		);

		await expect(
			addCommand(registry, indexLocation, {
				items: ["pr-template-configuration"],
				overwrite: true,
			}),
		).rejects.toThrow(
			'Compiled item file target "../escape.txt" must be a relative path (no absolute paths, URLs, or "..").',
		);
	});

	it("skips package-manager selection when the catalog and payload do not use npm", async () => {
		fs.rmSync(path.join(tempDir, "pnpm-lock.yaml"));

		await addCommand(registry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		expect(mockSelectInput).not.toHaveBeenCalledWith(
			"Which package manager should be used for the project?",
			expect.anything(),
			expect.anything(),
		);
	});

	it("selects a package manager when compiled files interpolate packageManager", async () => {
		fs.rmSync(path.join(tempDir, "pnpm-lock.yaml"));
		fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}\n");
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/pr-template-configuration.json",
					{
						files: [
							{
								target: ".github/dependabot.yml",
								content: "package-ecosystem: {{packageManager}}",
							},
						],
					},
				],
			]),
		);

		await addCommand(registry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		expect(mockWriteFileAsync).toHaveBeenCalledWith(
			path.join(tempDir, ".github/dependabot.yml"),
			"package-ecosystem: npm",
		);
	});

	it("installs npm packages using the selected package manager", async () => {
		fs.rmSync(path.join(tempDir, "pnpm-lock.yaml"));
		fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}\n");
		fs.writeFileSync(path.join(tempDir, "package.json"), "{}\n");
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/pr-template-configuration.json",
					{
						files: [
							{
								target: ".github/pull_request_template.md",
								content: "# PR Template",
							},
						],
						dependencies: {
							npm: {
								dev: ["vitest@^3"],
							},
						},
					},
				],
			]),
		);
		mockConfirmInput.mockResolvedValue(true);

		await addCommand(registry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		expect(mockConfirmInput).toHaveBeenCalledWith(
			"Install required dependencies?",
			{},
			true,
		);
		expect(mockSelectInput).not.toHaveBeenCalledWith(
			"Which package manager should be used for the project?",
			expect.anything(),
			expect.anything(),
		);
		expect(mockRunArgvAsync).toHaveBeenCalledWith(
			"npm",
			["install", "--ignore-scripts", "-D", "vitest@^3"],
			expect.objectContaining({ cwd: tempDir, stdio: "inherit" }),
		);
	});

	it("uses the selected package manager for next-step commands when install is declined", async () => {
		fs.writeFileSync(path.join(tempDir, "package.json"), "{}\n");
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/pr-template-configuration.json",
					{
						files: [
							{
								target: ".github/pull_request_template.md",
								content: "# PR Template",
							},
						],
						dependencies: {
							npm: {
								runtime: ["zod"],
								dev: ["vitest@^3"],
							},
						},
					},
				],
			]),
		);
		mockConfirmInput.mockResolvedValue(false);

		await addCommand(registry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		expect(mockRunArgvAsync).not.toHaveBeenCalled();
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining("Next steps"),
		);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining("Install dependencies:"),
		);
		expect(consoleLogSpy).not.toHaveBeenCalledWith(
			expect.stringContaining("Install dependencies with"),
		);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining("pnpm add --ignore-scripts zod"),
		);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining("pnpm add --ignore-scripts -D vitest@^3"),
		);
	});

	it("prompts for a package manager when no lockfile is present", async () => {
		fs.rmSync(path.join(tempDir, "pnpm-lock.yaml"));
		fs.writeFileSync(path.join(tempDir, "package.json"), "{}\n");
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/pr-template-configuration.json",
					{
						files: [
							{
								target: ".github/pull_request_template.md",
								content: "# PR Template",
							},
						],
						dependencies: {
							npm: {
								dev: ["vitest@^3"],
							},
						},
					},
				],
			]),
		);
		mockSelectInput.mockResolvedValue("npm");
		mockConfirmInput.mockResolvedValue(true);

		await addCommand(registry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		expect(mockSelectInput).toHaveBeenCalledWith(
			"Which package manager should be used for the project?",
			expect.objectContaining({
				options: expect.arrayContaining([
					{ label: "npm", value: "npm" },
					{ label: "Bun", value: "bun" },
				]),
			}),
			"npm",
		);
		expect(mockRunArgvAsync).toHaveBeenCalledWith(
			"npm",
			["install", "--ignore-scripts", "-D", "vitest@^3"],
			expect.objectContaining({ cwd: tempDir, stdio: "inherit" }),
		);
	});

	it("runs a local beforeWrite script before writing files", async () => {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const handlerDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-handler-"));
		const catalogPath = path.join(handlerDir, "registry.json");
		const scriptPath = path.join(handlerDir, "r/hello.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(catalogPath, "{}\n");
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite(ctx) {
  const name = ctx.conditions.authorName || "world";
  return {
    bindings: { name },
    files: [{ target: "HELLO.md", content: "Hello " + name }],
  };
};
`,
		);

		mockTextInput.mockResolvedValue("Ada");
		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "hello",
				beforeWriteScripts: ["r/hello.beforeWrite.0.js"],
			},
		]);

		const handlerRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				authorName: {
					kind: RegistryConditionKind.TEXT,
					required: true,
					label: "Author",
				},
			},
			items: {
				hello: {
					title: "Hello",
					description: "Install script demo",
					type: "configuration",
					requires: ["authorName"],
					beforeWrite: ["r/hello.beforeWrite.0.js"],
				},
			},
		};

		try {
			await addCommand(handlerRegistry, catalogPath, {
				items: ["hello"],
				overwrite: true,
			});

			expect(mockTextInput).toHaveBeenCalledWith(
				"Author",
				{ required: true },
				undefined,
			);
			expect(mockLoadCompiledItems).not.toHaveBeenCalled();
			expect(mockWriteFileAsync).toHaveBeenCalledWith(
				path.join(tempDir, "HELLO.md"),
				"Hello Ada",
			);
		} finally {
			fs.rmSync(handlerDir, { recursive: true, force: true });
		}
	});

	it("runs beforeWrite before writes and afterInstall after package install", async () => {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const handlerDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-lifecycle-"));
		const catalogPath = path.join(handlerDir, "registry.json");
		const logPath = path.join(tempDir, "lifecycle-order.log");
		const beforePath = path.join(handlerDir, "r/lifecycle.beforeWrite.0.js");
		const afterPath = path.join(handlerDir, "r/lifecycle.afterInstall.0.js");
		fs.mkdirSync(path.dirname(beforePath), { recursive: true });
		fs.writeFileSync(catalogPath, "{}\n");
		fs.writeFileSync(
			beforePath,
			`
const fs = require("node:fs");
module.exports = async function beforeWrite() {
  fs.appendFileSync(${JSON.stringify(logPath)}, "before\\n");
};
`,
		);
		fs.writeFileSync(
			afterPath,
			`
const fs = require("node:fs");
module.exports = async function afterInstall() {
  fs.appendFileSync(${JSON.stringify(logPath)}, "after\\n");
};
`,
		);

		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "lifecycle",
				sources: ["r/lifecycle.json"],
				beforeWriteScripts: ["r/lifecycle.beforeWrite.0.js"],
				afterInstallScripts: ["r/lifecycle.afterInstall.0.js"],
			},
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/lifecycle.json",
					{
						files: [{ target: "DONE.txt", content: "ok" }],
						dependencies: {
							npm: {
								dev: ["vitest@^3"],
							},
						},
					},
				],
			]),
		);
		mockConfirmInput.mockResolvedValue(true);
		mockRunArgvAsync.mockImplementation(async () => {
			fs.appendFileSync(logPath, "install\n");
		});

		const lifecycleRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				lifecycle: {
					title: "Lifecycle",
					description: "Lifecycle scripts",
					type: "configuration",
					source: "r/lifecycle.json",
					beforeWrite: ["r/lifecycle.beforeWrite.0.js"],
					afterInstall: ["r/lifecycle.afterInstall.0.js"],
				},
			},
		};

		try {
			await addCommand(lifecycleRegistry, catalogPath, {
				items: ["lifecycle"],
				overwrite: true,
			});

			expect(fs.readFileSync(logPath, "utf8")).toBe("before\ninstall\nafter\n");
			expect(mockWriteFileAsync).toHaveBeenCalledWith(
				path.join(tempDir, "DONE.txt"),
				"ok",
			);
			expect(mockRunWithTasks).toHaveBeenCalledWith(
				"Finishing setup",
				expect.arrayContaining([
					expect.objectContaining({
						title: expect.stringContaining("Lifecycle"),
					}),
				]),
			);
		} finally {
			fs.rmSync(handlerDir, { recursive: true, force: true });
		}
	});

	it("finalizes setup when dependency installation is declined", async () => {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const handlerDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "add-after-install-"),
		);
		const catalogPath = path.join(handlerDir, "registry.json");
		const logPath = path.join(tempDir, "after-install-declined.log");
		const afterPath = path.join(handlerDir, "r/lifecycle.afterInstall.0.js");
		fs.mkdirSync(path.dirname(afterPath), { recursive: true });
		fs.writeFileSync(catalogPath, "{}\n");
		fs.writeFileSync(
			afterPath,
			`
const fs = require("node:fs");
module.exports = async function afterInstall() {
  fs.appendFileSync(${JSON.stringify(logPath)}, "after\\n");
};
`,
		);

		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "lifecycle",
				sources: ["r/lifecycle.json"],
				afterInstallScripts: ["r/lifecycle.afterInstall.0.js"],
			},
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/lifecycle.json",
					{
						files: [{ target: "DONE.txt", content: "ok" }],
						dependencies: {
							npm: {
								dev: ["vitest@^3"],
							},
						},
					},
				],
			]),
		);
		mockConfirmInput.mockResolvedValue(false);

		const lifecycleRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				lifecycle: {
					title: "Lifecycle",
					description: "Lifecycle scripts",
					type: "configuration",
					source: "r/lifecycle.json",
					afterInstall: ["r/lifecycle.afterInstall.0.js"],
				},
			},
		};

		try {
			await addCommand(lifecycleRegistry, catalogPath, {
				items: ["lifecycle"],
				overwrite: true,
			});

			expect(fs.readFileSync(logPath, "utf8")).toBe("after\n");
			expect(mockRunArgvAsync).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(handlerDir, { recursive: true, force: true });
		}
	});

	it("skips the Finishing setup task when no items declare afterInstall scripts", async () => {
		// Default `mockBuildInstallPlan` returns a node without afterInstallScripts.
		await addCommand(registry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		const titles = mockRunWithTasks.mock.calls.map(([title]) => title);
		expect(titles).not.toContain("Finishing setup");
	});

	it("runs every afterInstall script for an item in declared order", async () => {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const handlerDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "add-after-multi-"),
		);
		const catalogPath = path.join(handlerDir, "registry.json");
		const logPath = path.join(tempDir, "after-multi.log");
		const dir = path.join(handlerDir, "r");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(catalogPath, "{}\n");
		for (const name of ["alpha", "beta", "gamma"]) {
			fs.writeFileSync(
				path.join(dir, `lifecycle.afterInstall.${name}.js`),
				`\nconst fs = require("node:fs");\nmodule.exports = async function afterInstall() {\n  fs.appendFileSync(${JSON.stringify(logPath)}, "${name}\\n");\n};\n`,
			);
		}

		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "lifecycle",
				sources: ["r/lifecycle.json"],
				afterInstallScripts: [
					"r/lifecycle.afterInstall.alpha.js",
					"r/lifecycle.afterInstall.beta.js",
					"r/lifecycle.afterInstall.gamma.js",
				],
			},
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/lifecycle.json",
					{ files: [{ target: "DONE.txt", content: "ok" }] },
				],
			]),
		);

		const lifecycleRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				lifecycle: {
					title: "Lifecycle",
					description: "Multiple after-install scripts",
					type: "configuration",
					source: "r/lifecycle.json",
					afterInstall: [
						"r/lifecycle.afterInstall.alpha.js",
						"r/lifecycle.afterInstall.beta.js",
						"r/lifecycle.afterInstall.gamma.js",
					],
				},
			},
		};

		try {
			await addCommand(lifecycleRegistry, catalogPath, {
				items: ["lifecycle"],
				overwrite: true,
			});

			expect(fs.readFileSync(logPath, "utf8")).toBe("alpha\nbeta\ngamma\n");
		} finally {
			fs.rmSync(handlerDir, { recursive: true, force: true });
		}
	});

	it("interpolates {{key}} in files and leaves GitHub Actions expressions intact", async () => {
		const local: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				defaultBranch: {
					kind: RegistryConditionKind.TEXT,
					required: true,
					label: "Default branch",
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo",
					type: "configuration",
					source: "r/demo.json",
					requires: ["defaultBranch"],
				},
			},
		};
		mockTextInput.mockResolvedValue("main");
		mockBuildInstallPlan.mockReturnValue([
			{ itemId: "demo", sources: ["r/demo.json"] },
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/demo.json",
					{
						files: [
							{
								target: "ci.yml",
								content: `branch: {{defaultBranch}}\nsha: \${{ github.sha }}\n`,
							},
						],
					},
				],
			]),
		);

		await addCommand(local, indexLocation, {
			items: ["demo"],
			overwrite: true,
		});

		expect(mockWriteFileAsync).toHaveBeenCalledWith(
			path.join(tempDir, "ci.yml"),
			`branch: main\nsha: \${{ github.sha }}\n`,
		);
	});

	it("merges payload commands into package.json scripts", async () => {
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			`${JSON.stringify({ name: "app", scripts: { start: "node ." } }, null, 2)}\n`,
		);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/pr-template-configuration.json",
					{
						files: [
							{
								target: ".github/pull_request_template.md",
								content: "# PR Template",
							},
						],
						commands: { npm: { test: "vitest run" } },
					},
				],
			]),
		);

		await addCommand(registry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		expect(mockWriteFileAsync).toHaveBeenCalledWith(
			path.join(tempDir, "package.json"),
			expect.stringContaining('"test": "vitest run"'),
		);
	});

	it("logs repository secret names in Next steps", async () => {
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/pr-template-configuration.json",
					{
						files: [
							{
								target: ".github/pull_request_template.md",
								content: "# PR Template",
							},
						],
						secrets: ["GH_ADMIN_TOKEN"],
					},
				],
			]),
		);

		await addCommand(registry, indexLocation, {
			items: ["pr-template-configuration"],
			overwrite: true,
		});

		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining("Next steps"),
		);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining("GH_ADMIN_TOKEN"),
		);
	});

	it("rejects duplicate compiled item targets across merged sources", async () => {
		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "pr-template-configuration",
				sources: ["r/base.json", "r/pack.json"],
			},
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				["r/base.json", { files: [{ target: "README.md", content: "base" }] }],
				["r/pack.json", { files: [{ target: "README.md", content: "pack" }] }],
			]),
		);

		await expect(
			addCommand(registry, indexLocation, {
				items: ["pr-template-configuration"],
				overwrite: true,
			}),
		).rejects.toThrow(
			'Registry item "pr-template-configuration" has duplicate compiled item target "README.md".',
		);
	});

	it("folds beforeWrite hook dependencies into the working compiled item", async () => {
		const handlerDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-deps-"));
		const catalogPath = path.join(handlerDir, "registry.json");
		const scriptPath = path.join(handlerDir, "r/hello.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(catalogPath, "{}\n");
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({ name: "demo", scripts: {} }),
			"utf8",
		);
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return {
    files: [{ target: "HELLO.md", content: "hi" }],
    dependencies: { npm: { runtime: ["left-pad"] } },
    commands: { npm: { hello: "echo hi" } },
    secrets: ["HELLO_TOKEN"],
  };
};
`,
		);

		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "hello",
				beforeWriteScripts: ["r/hello.beforeWrite.0.js"],
			},
		]);

		const handlerRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				hello: {
					title: "Hello",
					description: "Hook deps",
					type: "configuration",
					beforeWrite: ["r/hello.beforeWrite.0.js"],
				},
			},
		};

		try {
			await addCommand(handlerRegistry, catalogPath, {
				items: ["hello"],
				overwrite: true,
			});
			expect(mockWriteFileAsync).toHaveBeenCalledWith(
				path.join(tempDir, "HELLO.md"),
				"hi",
			);
			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("HELLO_TOKEN"),
			);
		} finally {
			fs.rmSync(handlerDir, { recursive: true, force: true });
		}
	});

	it("uses item-local condition values during interpolation", async () => {
		mockTextInput.mockResolvedValue("Ada");
		mockBuildInstallPlan.mockReturnValue([
			{
				itemId: "hello",
				sources: ["r/hello.json"],
			},
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				[
					"r/hello.json",
					{
						files: [
							{
								target: "HELLO.md",
								content: "Hello {{authorName}} {{language}}",
							},
						],
					},
				],
			]),
		);

		const localRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				hello: {
					title: "Hello",
					description: "Local conditions",
					type: "configuration",
					source: "r/hello.json",
					conditions: {
						authorName: {
							kind: RegistryConditionKind.TEXT,
							required: true,
							label: "Author",
						},
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: [{ value: "typescript", label: "TypeScript" }],
						},
					},
				},
			},
		};

		await addCommand(localRegistry, indexLocation, {
			items: ["hello"],
			overwrite: true,
		});

		expect(mockWriteFileAsync).toHaveBeenCalledWith(
			path.join(tempDir, "HELLO.md"),
			"Hello Ada typescript",
		);
	});

	it("rejects conflicting interpolation option values on the same condition key", async () => {
		mockBuildInstallPlan.mockReturnValue([
			{ itemId: "left", sources: ["r/left.json"] },
			{ itemId: "right", sources: ["r/right.json"] },
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				["r/left.json", { files: [{ target: "LEFT.md", content: "left" }] }],
				["r/right.json", { files: [{ target: "RIGHT.md", content: "right" }] }],
			]),
		);

		const conflictRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				left: {
					title: "Left",
					description: "Left item",
					type: "configuration",
					source: "r/left.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: [{ value: "typescript", label: "TypeScript" }],
						},
					},
				},
				right: {
					title: "Right",
					description: "Right item",
					type: "configuration",
					source: "r/right.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: [{ value: "javascript", label: "JavaScript" }],
						},
					},
				},
			},
		};

		await expect(
			addCommand(conflictRegistry, indexLocation, {
				items: ["left"],
				overwrite: true,
			}),
		).rejects.toThrow(
			'Condition "language" declares conflicting interpolation option values ("left" and "right").',
		);
	});

	it("rejects conflicting shared and item-local interpolation option values", async () => {
		mockBuildInstallPlan.mockReturnValue([
			{ itemId: "demo", sources: ["r/demo.json"] },
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				["r/demo.json", { files: [{ target: "DEMO.md", content: "demo" }] }],
			]),
		);

		const conflictRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				language: {
					kind: RegistryConditionKind.SELECT,
					required: true,
					label: "Language",
					values: [{ value: "typescript", label: "TypeScript" }],
				},
			},
			items: {
				demo: {
					title: "Demo",
					description: "Demo item",
					type: "configuration",
					source: "r/demo.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: [{ value: "javascript", label: "JavaScript" }],
						},
					},
				},
			},
		};

		await expect(
			addCommand(conflictRegistry, indexLocation, {
				items: ["demo"],
				overwrite: true,
			}),
		).rejects.toThrow(
			'Condition "language" declares conflicting interpolation option values (shared conditions and "demo").',
		);
	});

	it("rejects interpolation option values that only differ by bindings", async () => {
		mockBuildInstallPlan.mockReturnValue([
			{ itemId: "left", sources: ["r/left.json"] },
			{ itemId: "right", sources: ["r/right.json"] },
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				["r/left.json", { files: [{ target: "LEFT.md", content: "left" }] }],
				["r/right.json", { files: [{ target: "RIGHT.md", content: "right" }] }],
			]),
		);

		const conflictRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				left: {
					title: "Left",
					description: "Left item",
					type: "configuration",
					source: "r/left.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: [
								{
									value: "typescript",
									label: "TypeScript",
									bindings: { ext: "ts" },
								},
							],
						},
					},
				},
				right: {
					title: "Right",
					description: "Right item",
					type: "configuration",
					source: "r/right.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: [
								{
									value: "typescript",
									label: "TypeScript",
									bindings: { ext: "tsx" },
								},
							],
						},
					},
				},
			},
		};

		await expect(
			addCommand(conflictRegistry, indexLocation, {
				items: ["left"],
				overwrite: true,
			}),
		).rejects.toThrow(
			'Condition "language" declares conflicting interpolation option values ("left" and "right").',
		);
	});

	it("rejects interpolation options when only the right side declares bindings", async () => {
		mockBuildInstallPlan.mockReturnValue([
			{ itemId: "left", sources: ["r/left.json"] },
			{ itemId: "right", sources: ["r/right.json"] },
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				["r/left.json", { files: [{ target: "LEFT.md", content: "left" }] }],
				["r/right.json", { files: [{ target: "RIGHT.md", content: "right" }] }],
			]),
		);

		const conflictRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				left: {
					title: "Left",
					description: "Left item",
					type: "configuration",
					source: "r/left.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: [{ value: "typescript", label: "TypeScript" }],
						},
					},
				},
				right: {
					title: "Right",
					description: "Right item",
					type: "configuration",
					source: "r/right.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: [
								{
									value: "typescript",
									label: "TypeScript",
									bindings: { ext: "tsx" },
								},
							],
						},
					},
				},
			},
		};

		await expect(
			addCommand(conflictRegistry, indexLocation, {
				items: ["left"],
				overwrite: true,
			}),
		).rejects.toThrow(
			'Condition "language" declares conflicting interpolation option values ("left" and "right").',
		);
	});

	it("rejects interpolation options when only the left side declares bindings", async () => {
		mockBuildInstallPlan.mockReturnValue([
			{ itemId: "left", sources: ["r/left.json"] },
			{ itemId: "right", sources: ["r/right.json"] },
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				["r/left.json", { files: [{ target: "LEFT.md", content: "left" }] }],
				["r/right.json", { files: [{ target: "RIGHT.md", content: "right" }] }],
			]),
		);

		const conflictRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				left: {
					title: "Left",
					description: "Left item",
					type: "configuration",
					source: "r/left.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: [
								{
									value: "typescript",
									label: "TypeScript",
									bindings: { ext: "ts" },
								},
							],
						},
					},
				},
				right: {
					title: "Right",
					description: "Right item",
					type: "configuration",
					source: "r/right.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: [{ value: "typescript", label: "TypeScript" }],
						},
					},
				},
			},
		};

		await expect(
			addCommand(conflictRegistry, indexLocation, {
				items: ["left"],
				overwrite: true,
			}),
		).rejects.toThrow(
			'Condition "language" declares conflicting interpolation option values ("left" and "right").',
		);
	});

	it("rejects interpolation option lists that differ only in length", async () => {
		mockBuildInstallPlan.mockReturnValue([
			{ itemId: "left", sources: ["r/left.json"] },
			{ itemId: "right", sources: ["r/right.json"] },
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				["r/left.json", { files: [{ target: "LEFT.md", content: "left" }] }],
				["r/right.json", { files: [{ target: "RIGHT.md", content: "right" }] }],
			]),
		);

		const conflictRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				left: {
					title: "Left",
					description: "Left item",
					type: "configuration",
					source: "r/left.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: [
								{ value: "typescript", label: "TypeScript" },
								{ value: "javascript", label: "JavaScript" },
							],
						},
					},
				},
				right: {
					title: "Right",
					description: "Right item",
					type: "configuration",
					source: "r/right.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: [{ value: "typescript", label: "TypeScript" }],
						},
					},
				},
			},
		};

		await expect(
			addCommand(conflictRegistry, indexLocation, {
				items: ["left"],
				overwrite: true,
			}),
		).rejects.toThrow(
			'Condition "language" declares conflicting interpolation option values ("left" and "right").',
		);
	});

	it("allows identical interpolation option arrays that share a reference", async () => {
		const sharedValues = [{ value: "typescript", label: "TypeScript" }];
		mockBuildInstallPlan.mockReturnValue([
			{ itemId: "left", sources: ["r/left.json"] },
			{ itemId: "right", sources: ["r/right.json"] },
		]);
		mockLoadCompiledItems.mockResolvedValue(
			new Map([
				["r/left.json", { files: [{ target: "LEFT.md", content: "left" }] }],
				["r/right.json", { files: [{ target: "RIGHT.md", content: "right" }] }],
			]),
		);

		const sharedRegistry: Registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				left: {
					title: "Left",
					description: "Left item",
					type: "configuration",
					source: "r/left.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: sharedValues,
						},
					},
				},
				right: {
					title: "Right",
					description: "Right item",
					type: "configuration",
					source: "r/right.json",
					conditions: {
						language: {
							kind: RegistryConditionKind.SELECT,
							required: true,
							label: "Language",
							values: sharedValues,
						},
					},
				},
			},
		};

		await addCommand(sharedRegistry, indexLocation, {
			items: ["left"],
			overwrite: true,
		});

		expect(mockWriteFileAsync).toHaveBeenCalled();
	});
});
