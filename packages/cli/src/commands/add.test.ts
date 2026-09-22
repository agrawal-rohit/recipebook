import * as core from "@cheetos/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { addCommand } from "./add";

const coreMocks = vi.hoisted(() => ({
	buildInstallPlan: vi.fn(),
	catalogNeedsPackageManager: vi.fn(() => false),
	collectRegistryDependencies: vi.fn(),
	compiledItemUsesEcosystem: vi.fn(() => false),
	packageManagerDropsCandidateDependsOn: vi.fn(() => false),
	selectPackageManager: vi.fn(),
	runAfterInstallHook: vi.fn(),
	runBeforeWriteHook: vi.fn(),
	setScriptExecutor: vi.fn(),
}));

vi.mock("@cheetos/core", async (importOriginal) => ({
	...(await importOriginal()),
	...coreMocks,
}));

const scriptsMocks = vi.hoisted(() => ({
	projectScriptHelpers: vi.fn(() => ({})),
	prepareScriptExecution: vi.fn(),
}));
vi.mock("../utils/scripts", () => scriptsMocks);

const conditionsMocks = vi.hoisted(() => ({
	captureRequiredConditions: vi.fn(),
	captureItemLocalConditionsForPlan: vi.fn(),
}));
vi.mock("../utils/conditions", () => conditionsMocks);

const registryMocks = vi.hoisted(() => ({
	loadCompiledItems: vi.fn(),
}));
vi.mock("../utils/registry", () => registryMocks);

const filesMocks = vi.hoisted(() => ({
	confirmFileOverwrites: vi.fn(),
	planFileWrites: vi.fn(),
	writePlannedFile: vi.fn(),
}));
vi.mock("../utils/files", () => filesMocks);

const packagesMocks = vi.hoisted(() => ({
	installDeclaredPackages: vi.fn(),
	mergeProjectCommands: vi.fn(),
}));
vi.mock("../utils/packages", () => packagesMocks);

const promptsMocks = vi.hoisted(() => ({
	groupedSelectInput: vi.fn(),
	selectInput: vi.fn(),
}));
vi.mock("../cli/prompts", () => promptsMocks);

const tasksMocks = vi.hoisted(() => ({
	task: vi.fn((title: string, fn: () => Promise<void>) => ({
		title,
		task: fn,
	})),
	taskGroup: vi.fn((title: string, subtasks: unknown[]) => ({
		title,
		subtasks,
	})),
	runWithTasks: vi.fn(
		async (
			_title: string,
			work:
				| (() => Promise<void>)
				| Array<{
						task?: () => Promise<void>;
						subtasks?: Array<{ task?: () => Promise<void> }>;
				  }>,
		) => {
			if (typeof work === "function") {
				await work();
				return;
			}
			for (const group of work) {
				const items =
					group && Array.isArray(group.subtasks)
						? group.subtasks
						: group
							? [group]
							: [];
				for (const sub of items) if (sub?.task) await sub.task();
			}
		},
	),
}));
vi.mock("../cli/tasks", () => tasksMocks);

const buttonFile = { target: "button.txt", content: "plain content" };

const buttonIndexItem: core.IndexItem = {
	title: "Button",
	description: "A button component",
	type: "component",
	source: "r/compiled/button.json",
};

function baseRegistry(): core.Registry {
	return {
		types: {
			component: { label: "Components" },
			framework: { label: "Frameworks" },
		},
		items: { button: buttonIndexItem },
	};
}

/** Install-plan node that installs the `button` item with a source payload. */
function buttonPlanNode(): core.InstallNode {
	return { itemId: "button", sources: ["r/compiled/button.json"] };
}

let logOutput: string[];

describe("addCommand orchestration", () => {
	beforeEach(() => {
		// Reset every mocked seam from the previous test, then restore the happy-path defaults.
		for (const mock of Object.values(coreMocks)) mock.mockReset();
		for (const mock of Object.values(promptsMocks)) mock.mockReset();
		for (const mock of [
			scriptsMocks.projectScriptHelpers,
			scriptsMocks.prepareScriptExecution,
			conditionsMocks.captureRequiredConditions,
			conditionsMocks.captureItemLocalConditionsForPlan,
			registryMocks.loadCompiledItems,
			filesMocks.confirmFileOverwrites,
			filesMocks.planFileWrites,
			filesMocks.writePlannedFile,
			packagesMocks.installDeclaredPackages,
			packagesMocks.mergeProjectCommands,
			tasksMocks.task,
			tasksMocks.taskGroup,
			tasksMocks.runWithTasks,
		])
			mock.mockReset();

		// Happy-path defaults: no ecosystem, single source-backed button install.
		coreMocks.catalogNeedsPackageManager.mockReturnValue(false);
		coreMocks.packageManagerDropsCandidateDependsOn.mockReturnValue(false);
		coreMocks.compiledItemUsesEcosystem.mockReturnValue(false);
		coreMocks.collectRegistryDependencies.mockReturnValue([
			{ itemId: "button", item: buttonIndexItem },
		]);
		coreMocks.buildInstallPlan.mockReturnValue([buttonPlanNode()]);
		coreMocks.selectPackageManager.mockResolvedValue("pnpm");
		coreMocks.runBeforeWriteHook.mockResolvedValue({ files: [], bindings: {} });
		coreMocks.runAfterInstallHook.mockResolvedValue(undefined);

		scriptsMocks.projectScriptHelpers.mockReturnValue({});
		scriptsMocks.prepareScriptExecution.mockResolvedValue({
			trust: "untrusted" as core.RegistryTrust,
			allowInfer: false,
			allowMutation: false,
		});
		conditionsMocks.captureRequiredConditions.mockResolvedValue({});
		conditionsMocks.captureItemLocalConditionsForPlan.mockImplementation(
			async (
				_registry: core.Registry,
				_indexLocation: string,
				_items: string[],
				plan: core.InstallNode[],
				conditions: core.RegistryContext,
			) => ({ context: conditions, plan }),
		);
		registryMocks.loadCompiledItems.mockResolvedValue(
			new Map<string, core.CompiledItem>([
				["r/compiled/button.json", core.compiledItem({ files: [buttonFile] })],
			]),
		);
		filesMocks.planFileWrites.mockResolvedValue({
			items: [
				{
					label: "Button",
					files: [
						{
							target: "button.txt",
							destination: "/proj/button.txt",
							content: "plain content",
							projectDir: "/proj",
						},
					],
				},
			],
			conflicts: [],
		});
		filesMocks.confirmFileOverwrites.mockResolvedValue(undefined);
		filesMocks.writePlannedFile.mockResolvedValue(undefined);
		packagesMocks.installDeclaredPackages.mockResolvedValue([]);
		packagesMocks.mergeProjectCommands.mockResolvedValue(undefined);
		promptsMocks.groupedSelectInput.mockResolvedValue("button");
		promptsMocks.selectInput.mockResolvedValue("pnpm");

		logOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map((arg) => String(arg)).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("it should write files, merge project commands, install no packages, print a summary, and reset the script executor on the happy path because every staged step must run in order", async () => {
		await addCommand(baseRegistry(), "/index/registry.json", {
			items: ["button"],
		});

		expect(filesMocks.planFileWrites).toHaveBeenCalledWith(process.cwd(), [
			{
				label: "Button",
				node: { itemId: "button", sources: ["r/compiled/button.json"] },
				compiledItem: core.compiledItem({ files: [buttonFile] }),
			},
		]);
		expect(filesMocks.confirmFileOverwrites).toHaveBeenCalledWith([], false);
		expect(filesMocks.writePlannedFile).toHaveBeenCalledWith(
			expect.objectContaining({
				target: "button.txt",
				destination: "/proj/button.txt",
			}),
		);
		expect(packagesMocks.mergeProjectCommands).toHaveBeenCalledWith(
			process.cwd(),
			[{ files: [{ target: "button.txt", content: "plain content" }] }],
			false,
		);
		expect(packagesMocks.installDeclaredPackages).not.toHaveBeenCalled();
		expect(coreMocks.setScriptExecutor).toHaveBeenCalledWith(undefined);
		expect(logOutput.join("\n")).toContain("Installed 1 item.");
		// The task-phase titles are user-facing copy; both stages must announce
		// themselves in order.
		expect(tasksMocks.runWithTasks.mock.calls.map((call) => call[0])).toEqual([
			"Preparing changes",
			"Adding item content",
		]);
	});

	test("it should run the install pipeline in the contract order: hooks, plan, confirm, write, merge, install, finalize because every later stage consumes the earlier stage's output", async () => {
		coreMocks.catalogNeedsPackageManager.mockReturnValue(true);
		coreMocks.buildInstallPlan.mockReturnValue([
			{
				itemId: "button",
				sources: ["r/compiled/button.json"],
				beforeWriteScripts: ["r/before.js"],
				afterInstallScripts: ["r/after.js"],
			},
		]);

		await addCommand(baseRegistry(), "/index/registry.json", {
			items: ["button"],
		});

		const order = [
			coreMocks.runBeforeWriteHook.mock.invocationCallOrder[0],
			filesMocks.planFileWrites.mock.invocationCallOrder[0],
			filesMocks.confirmFileOverwrites.mock.invocationCallOrder[0],
			filesMocks.writePlannedFile.mock.invocationCallOrder[0],
			packagesMocks.mergeProjectCommands.mock.invocationCallOrder[0],
			packagesMocks.installDeclaredPackages.mock.invocationCallOrder[0],
			coreMocks.runAfterInstallHook.mock.invocationCallOrder[0],
		];
		expect(order.every((callOrder) => callOrder !== undefined)).toBe(true);
		for (let index = 1; index < order.length; index += 1)
			expect(order[index - 1]).toBeLessThan(order[index]);
	});

	test("it should run lifecycle hooks in install-plan order across nodes because a later node's hook may read an earlier node's bindings", async () => {
		const registry = baseRegistry();
		registry.items.zeta = {
			title: "Zeta",
			description: "zeta component",
			type: "component",
			source: "r/compiled/zeta.json",
		};
		coreMocks.buildInstallPlan.mockReturnValue([
			{
				itemId: "zeta",
				sources: ["r/compiled/zeta.json"],
				beforeWriteScripts: ["r/zeta-before.js"],
				afterInstallScripts: ["r/zeta-after.js"],
			},
			{
				itemId: "button",
				sources: ["r/compiled/button.json"],
				beforeWriteScripts: ["r/button-before.js"],
				afterInstallScripts: ["r/button-after.js"],
			},
		]);
		registryMocks.loadCompiledItems.mockResolvedValue(
			new Map<string, core.CompiledItem>([
				["r/compiled/zeta.json", core.compiledItem({ files: [buttonFile] })],
				["r/compiled/button.json", core.compiledItem({ files: [buttonFile] })],
			]),
		);

		await addCommand(registry, "/index/registry.json", { items: ["button"] });

		expect(
			coreMocks.runBeforeWriteHook.mock.calls.map((call) => call[1]),
		).toEqual(["r/zeta-before.js", "r/button-before.js"]);
		expect(
			coreMocks.runAfterInstallHook.mock.calls.map((call) => call[1]),
		).toEqual(["r/zeta-after.js", "r/button-after.js"]);
	});

	test("it should pass the overwrite flag through to overwrite-confirmation and command merge when --overwrite is set because --overwrite skips prompts but never deletes payload", async () => {
		filesMocks.planFileWrites.mockResolvedValue({
			items: [
				{
					label: "Button",
					files: [
						{
							target: "button.txt",
							destination: "/proj/button.txt",
							content: "plain content",
							projectDir: "/proj",
						},
					],
				},
			],
			conflicts: ["button.txt"],
		});

		await addCommand(baseRegistry(), "/index/registry.json", {
			items: ["button"],
			overwrite: true,
		});

		expect(filesMocks.confirmFileOverwrites).toHaveBeenCalledWith(
			["button.txt"],
			true,
		);
		expect(packagesMocks.mergeProjectCommands).toHaveBeenCalledWith(
			process.cwd(),
			[{ files: [{ target: "button.txt", content: "plain content" }] }],
			true,
		);
	});

	test("it should skip overwrite prompts when --overwrite is absent but there are no conflicts because there is nothing to confirm", async () => {
		await addCommand(baseRegistry(), "/index/registry.json", {
			items: ["button"],
		});
		expect(filesMocks.confirmFileOverwrites).toHaveBeenCalledWith([], false);
	});

	test("it should install declared packages and print Next steps with install commands and repo secrets when a package manager is used and secrets exist because the summary must surface both pending actions", async () => {
		coreMocks.catalogNeedsPackageManager.mockReturnValue(true);
		packagesMocks.installDeclaredPackages.mockResolvedValue(["pnpm add foo"]);
		registryMocks.loadCompiledItems.mockResolvedValue(
			new Map<string, core.CompiledItem>([
				[
					"r/compiled/button.json",
					core.compiledItem({
						files: [buttonFile],
						secrets: ["GITHUB_TOKEN"],
					}),
				],
			]),
		);

		await addCommand(baseRegistry(), "/index/registry.json", {
			items: ["button"],
		});

		expect(coreMocks.selectPackageManager).toHaveBeenCalled();
		expect(packagesMocks.installDeclaredPackages).toHaveBeenCalled();
		const output = logOutput.join("\n");
		expect(output).toContain("Next steps");
		expect(output).toContain("Install dependencies");
		expect(output).toContain("pnpm add foo");
		expect(output).toContain(
			"Configure the following repository secrets in GitHub",
		);
		expect(output).toContain("GITHUB_TOKEN");
	});

	test("it should print only the repo-secrets Next step when there are secrets but no pending package commands because each step prints independently", async () => {
		registryMocks.loadCompiledItems.mockResolvedValue(
			new Map<string, core.CompiledItem>([
				[
					"r/compiled/button.json",
					core.compiledItem({
						files: [buttonFile],
						secrets: ["DEPLOY_KEY"],
					}),
				],
			]),
		);

		await addCommand(baseRegistry(), "/index/registry.json", {
			items: ["button"],
		});

		const output = logOutput.join("\n");
		expect(output).toContain("Next steps");
		expect(output).toContain("DEPLOY_KEY");
		expect(output).not.toContain("Install dependencies");
	});

	test("it should print only the dependency Next step when packages are pending but there are no secrets because the two steps print independently", async () => {
		coreMocks.catalogNeedsPackageManager.mockReturnValue(true);
		packagesMocks.installDeclaredPackages.mockResolvedValue(["pnpm add foo"]);

		await addCommand(baseRegistry(), "/index/registry.json", {
			items: ["button"],
		});

		const output = logOutput.join("\n");
		expect(output).toContain("Next steps");
		expect(output).toContain("Install dependencies");
		expect(output).toContain("pnpm add foo");
		expect(output).not.toContain(
			"Configure the following repository secrets in GitHub",
		);
	});

	test("it should skip the Next steps section entirely when there are no pending install commands and no secrets because an empty summary has nothing of value", async () => {
		await addCommand(baseRegistry(), "/index/registry.json", {
			items: ["button"],
		});
		expect(logOutput.join("\n")).not.toContain("Next steps");
	});

	test("it should run beforeWrite and afterInstall install lifecycle hooks in plan order when a node declares them because lifecycle scripts mutate the payload and run side effects", async () => {
		coreMocks.catalogNeedsPackageManager.mockReturnValue(true);
		coreMocks.buildInstallPlan.mockReturnValue([
			{
				itemId: "button",
				sources: ["r/compiled/button.json"],
				beforeWriteScripts: ["r/before.js"],
				afterInstallScripts: ["r/after.js"],
			},
		]);
		coreMocks.runBeforeWriteHook.mockResolvedValue({
			files: [{ target: "hook.txt", content: "from hook" }],
			bindings: { hookKey: "1" },
		});

		await addCommand(baseRegistry(), "/index/registry.json", {
			items: ["button"],
		});

		expect(coreMocks.runBeforeWriteHook).toHaveBeenCalledWith(
			"/index/registry.json",
			"r/before.js",
			{},
			{
				itemId: "button",
				conditions: {},
				packageManager: "pnpm",
				bindings: { hookKey: "1" },
				compiledItem: {
					files: [{ target: "button.txt", content: "plain content" }],
				},
			},
		);
		expect(coreMocks.runAfterInstallHook).toHaveBeenCalledWith(
			"/index/registry.json",
			"r/after.js",
			{},
			{
				itemId: "button",
				conditions: {},
				packageManager: "pnpm",
				bindings: { hookKey: "1" },
				compiledItem: {
					files: [{ target: "hook.txt", content: "from hook" }],
				},
			},
		);
	});
});

describe("addCommand prompts and validation", () => {
	beforeEach(() => {
		for (const mock of Object.values(promptsMocks)) mock.mockReset();
		for (const mock of [
			scriptsMocks.prepareScriptExecution,
			registryMocks.loadCompiledItems,
			filesMocks.planFileWrites,
			packagesMocks.installDeclaredPackages,
			tasksMocks.runWithTasks,
			packagesMocks.mergeProjectCommands,
			filesMocks.confirmFileOverwrites,
		])
			mock.mockClear();
		coreMocks.setScriptExecutor.mockReset();
		coreMocks.buildInstallPlan.mockReset();
		coreMocks.collectRegistryDependencies.mockReset();
		coreMocks.catalogNeedsPackageManager.mockReturnValue(false);
		coreMocks.collectRegistryDependencies.mockReturnValue([
			{ itemId: "button", item: buttonIndexItem },
		]);
		coreMocks.buildInstallPlan.mockReturnValue([buttonPlanNode()]);
		scriptsMocks.projectScriptHelpers.mockReturnValue({});
		scriptsMocks.prepareScriptExecution.mockResolvedValue({
			trust: "untrusted" as core.RegistryTrust,
			allowInfer: false,
			allowMutation: false,
		});
		conditionsMocks.captureRequiredConditions.mockResolvedValue({});
		conditionsMocks.captureItemLocalConditionsForPlan.mockImplementation(
			async (_r, _i, _items, plan, conditions) => ({
				context: conditions,
				plan,
			}),
		);
		registryMocks.loadCompiledItems.mockResolvedValue(
			new Map<string, core.CompiledItem>([
				["r/compiled/button.json", core.compiledItem({ files: [buttonFile] })],
			]),
		);
		filesMocks.planFileWrites.mockResolvedValue({ items: [], conflicts: [] });
		filesMocks.confirmFileOverwrites.mockResolvedValue(undefined);
		packagesMocks.installDeclaredPackages.mockResolvedValue([]);
		packagesMocks.mergeProjectCommands.mockResolvedValue(undefined);

		logOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map((arg) => String(arg)).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("it should prompt for the item with a grouped select ordered and grouped by type when no items are passed because selection falls back to an interactive prompt", async () => {
		const registry = baseRegistry();
		// Declared out of title order (aaa first, titled "Zzz") so dropping the
		// sort is observable: the prompt must present items sorted by title,
		// not in registry insertion order.
		registry.items.aaa = {
			title: "Zzz",
			description: "aaa component",
			type: "component",
			source: "r/compiled/aaa.json",
		};
		registry.items.other = {
			title: "Alpha",
			description: "other",
			type: "framework",
			source: "r/compiled/other.json",
		};
		registry.items.zeta = {
			title: "Zeta",
			description: "zeta component",
			type: "component",
			source: "r/compiled/zeta.json",
		};
		promptsMocks.groupedSelectInput.mockResolvedValue("other");

		await addCommand(registry, "/index/registry.json");

		expect(promptsMocks.groupedSelectInput).toHaveBeenCalledWith(
			"Which registry item should be added?",
			{
				Components: [
					{ value: "button", label: "Button", hint: "A button component" },
					{ value: "zeta", label: "Zeta", hint: "zeta component" },
					{ value: "aaa", label: "Zzz", hint: "aaa component" },
				],
				Frameworks: [{ value: "other", label: "Alpha", hint: "other" }],
			},
		);
		// The user's choice must drive the plan: what gets installed is the
		// selected item, not the first registry entry.
		expect(coreMocks.collectRegistryDependencies).toHaveBeenCalledWith(
			["other"],
			registry.items,
			{},
		);
	});

	test("it should omit a declared type with no items from the grouped select because an empty group offers no choice", async () => {
		const registry = baseRegistry();
		registry.types.hook = { label: "Hooks" };
		promptsMocks.groupedSelectInput.mockResolvedValue("button");

		await addCommand(registry, "/index/registry.json");

		const groups = promptsMocks.groupedSelectInput.mock.calls[0]?.[1] as Record<
			string,
			unknown
		>;
		// `framework` is declared in the base registry with no matching items
		// either; both empty groups must disappear.
		expect(Object.keys(groups)).toEqual(["Components"]);
	});

	test("it should throw an actionable error when the registry has no items because there is nothing to select from", async () => {
		const empty = baseRegistry();
		empty.items = {};
		await expect(addCommand(empty, "/index/registry.json")).rejects.toThrow(
			"No registry items are available.",
		);
	});

	test("it should throw when an unknown item id is passed because the id must exist in the registry", async () => {
		await expect(
			addCommand(baseRegistry(), "/index/registry.json", {
				items: ["does-not-exist"],
			}),
		).rejects.toThrow('Registry item not found: "does-not-exist".');
	});

	test("it should throw when more than one item is passed because `add` installs one registry item at a time", async () => {
		await expect(
			addCommand(baseRegistry(), "/index/registry.json", {
				items: ["button", "other"],
			}),
		).rejects.toThrow(
			"add installs one registry item at a time; pass a single item id.",
		);
	});

	test("it should throw when the install plan is empty because a no-op install must be rejected before any writes", async () => {
		coreMocks.buildInstallPlan.mockReturnValue([]);
		await expect(
			addCommand(baseRegistry(), "/index/registry.json", { items: ["button"] }),
		).rejects.toThrow("No registry item was selected for installation.");
	});
});

describe("addCommand compiled-item and condition aggregation errors", () => {
	beforeEach(() => {
		for (const mock of [
			coreMocks.buildInstallPlan,
			coreMocks.collectRegistryDependencies,
			coreMocks.catalogNeedsPackageManager,
			coreMocks.setScriptExecutor,
			coreMocks.compiledItemUsesEcosystem,
		])
			mock.mockReset();
		for (const mock of [
			registryMocks.loadCompiledItems,
			filesMocks.planFileWrites,
			scriptsMocks.prepareScriptExecution,
			conditionsMocks.captureRequiredConditions,
			conditionsMocks.captureItemLocalConditionsForPlan,
		])
			mock.mockClear();
		coreMocks.catalogNeedsPackageManager.mockReturnValue(false);
		coreMocks.compiledItemUsesEcosystem.mockReturnValue(false);
		coreMocks.collectRegistryDependencies.mockReturnValue([
			{ itemId: "button", item: buttonIndexItem },
		]);
		registryMocks.loadCompiledItems.mockResolvedValue(new Map());
		scriptsMocks.projectScriptHelpers.mockReturnValue({});
		scriptsMocks.prepareScriptExecution.mockResolvedValue({
			trust: "untrusted" as core.RegistryTrust,
			allowInfer: false,
			allowMutation: false,
		});
		conditionsMocks.captureRequiredConditions.mockResolvedValue({});
		conditionsMocks.captureItemLocalConditionsForPlan.mockImplementation(
			async (_r, _i, _items, plan, conditions) => ({
				context: conditions,
				plan,
			}),
		);
		filesMocks.planFileWrites.mockResolvedValue({ items: [], conflicts: [] });
		filesMocks.confirmFileOverwrites.mockResolvedValue(undefined);
		packagesMocks.installDeclaredPackages.mockResolvedValue([]);
		packagesMocks.mergeProjectCommands.mockResolvedValue(undefined);
		logOutput = [];
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("it should throw when a planned compiled source is missing because the plan cannot proceed without every source", async () => {
		coreMocks.buildInstallPlan.mockReturnValue([
			{ itemId: "button", sources: ["r/missing.json"] },
		]);
		await expect(
			addCommand(baseRegistry(), "/index/registry.json", { items: ["button"] }),
		).rejects.toThrow(
			'Missing compiled item for registry item "button" (r/missing.json).',
		);
		// The failure happened inside the guarded body, so the executor is still reset.
		expect(coreMocks.setScriptExecutor).toHaveBeenCalledWith(undefined);
	});

	test("it should throw when two compiled sources for one item declare the same file target because folding must reject collisions", async () => {
		coreMocks.buildInstallPlan.mockReturnValue([
			{
				itemId: "button",
				sources: ["a.json", "b.json"],
			},
		]);
		registryMocks.loadCompiledItems.mockResolvedValue(
			new Map<string, core.CompiledItem>([
				["a.json", core.compiledItem({ files: [buttonFile] })],
				[
					"b.json",
					core.compiledItem({
						files: [{ target: "button.txt", content: "different" }],
					}),
				],
			]),
		);
		await expect(
			addCommand(baseRegistry(), "/index/registry.json", { items: ["button"] }),
		).rejects.toThrow(
			'Registry item "button" has duplicate compiled item target "button.txt".',
		);
	});

	test("it should reset the script executor via finally even when an install-plan step throws inside the guarded body because the executor must never leak", async () => {
		coreMocks.buildInstallPlan.mockReturnValue([]);
		try {
			await addCommand(baseRegistry(), "/index/registry.json", {
				items: ["button"],
			});
		} catch {
			// expected
		}
		expect(coreMocks.setScriptExecutor).toHaveBeenCalledWith(undefined);
	});

	test("it should throw when shared and item-local conditions declare conflicting interpolation option values for the same key because prompts must never offer ambiguous pick lists", async () => {
		const registry = baseRegistry();
		registry.conditions = {
			framework: {
				label: "Framework",
				kind: core.RegistryConditionKind.SELECT,
				values: [{ value: "react", label: "React" }],
			},
		};
		registry.items.button.conditions = {
			framework: {
				label: "Framework",
				kind: core.RegistryConditionKind.SELECT,
				values: [{ value: "vue", label: "Vue" }],
			},
		};
		coreMocks.buildInstallPlan.mockReturnValue([
			{ itemId: "button", sources: [] },
		]);
		await expect(
			addCommand(registry, "/index/registry.json", { items: ["button"] }),
		).rejects.toThrow(
			'Condition "framework" declares conflicting interpolation option values (shared conditions and "button").',
		);
	});

	test("it should promote a source-less item to an empty compiled item without an error because script-only items contribute no files", async () => {
		coreMocks.buildInstallPlan.mockReturnValue([
			{ itemId: "button", sources: [] },
		]);
		await addCommand(baseRegistry(), "/index/registry.json", {
			items: ["button"],
		});
		expect(coreMocks.setScriptExecutor).toHaveBeenCalledWith(undefined);
		const plannedItems = filesMocks.planFileWrites.mock.calls[0]?.[1] as
			| Array<{ compiledItem: core.CompiledItem }>
			| undefined;
		expect(plannedItems?.[0]?.compiledItem.files).toEqual([]);
	});

	test("it should reject an install plan that names an item missing from the registry because every plan node must resolve before writes", async () => {
		coreMocks.buildInstallPlan.mockReturnValue([
			{ itemId: "ghost", sources: [] },
		]);
		await expect(
			addCommand(baseRegistry(), "/index/registry.json", { items: ["button"] }),
		).rejects.toThrow('Install plan references unknown registry item "ghost".');
		// Fail fast: an invalid plan must be rejected by assertInstallPlan before
		// condition capture or any other plan work happens.
		expect(
			conditionsMocks.captureItemLocalConditionsForPlan,
		).not.toHaveBeenCalled();
		expect(coreMocks.setScriptExecutor).toHaveBeenCalledWith(undefined);
	});

	test("it should merge shared and item-local interpolation option lists that declare identical values because equal lists are not a conflict", async () => {
		const registry = baseRegistry();
		registry.conditions = {
			framework: {
				label: "Framework",
				kind: core.RegistryConditionKind.SELECT,
				values: [{ value: "react", label: "React" }],
			},
		};
		registry.items.button.conditions = {
			framework: {
				label: "Framework",
				kind: core.RegistryConditionKind.SELECT,
				values: [{ value: "react", label: "React" }],
			},
		};
		coreMocks.buildInstallPlan.mockReturnValue([
			{ itemId: "button", sources: [] },
		]);

		await addCommand(registry, "/index/registry.json", { items: ["button"] });

		expect(coreMocks.setScriptExecutor).toHaveBeenCalledWith(undefined);
	});
});

describe("addCommand package-manager dependency re-collection", () => {
	beforeEach(() => {
		for (const mock of [
			coreMocks.catalogNeedsPackageManager,
			coreMocks.packageManagerDropsCandidateDependsOn,
			coreMocks.collectRegistryDependencies,
			coreMocks.selectPackageManager,
			coreMocks.setScriptExecutor,
		])
			mock.mockReset();
		coreMocks.catalogNeedsPackageManager.mockReturnValue(true);
		coreMocks.packageManagerDropsCandidateDependsOn.mockReturnValue(true);
		coreMocks.collectRegistryDependencies.mockReturnValue([
			{ itemId: "button", item: buttonIndexItem },
		]);
		coreMocks.selectPackageManager.mockResolvedValue("pnpm");
		coreMocks.buildInstallPlan.mockReturnValue([buttonPlanNode()]);
		scriptsMocks.projectScriptHelpers.mockReturnValue({});
		scriptsMocks.prepareScriptExecution.mockResolvedValue({
			trust: "untrusted" as core.RegistryTrust,
			allowInfer: false,
			allowMutation: false,
		});
		conditionsMocks.captureRequiredConditions.mockResolvedValue({});
		conditionsMocks.captureItemLocalConditionsForPlan.mockImplementation(
			async (_r, _i, _items, plan, conditions) => ({
				context: conditions,
				plan,
			}),
		);
		registryMocks.loadCompiledItems.mockResolvedValue(
			new Map<string, core.CompiledItem>([
				["r/compiled/button.json", core.compiledItem({ files: [buttonFile] })],
			]),
		);
		filesMocks.planFileWrites.mockResolvedValue({ items: [], conflicts: [] });
		filesMocks.confirmFileOverwrites.mockResolvedValue(undefined);
		packagesMocks.installDeclaredPackages.mockResolvedValue([]);
		packagesMocks.mergeProjectCommands.mockResolvedValue(undefined);
		logOutput = [];
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("it should re-collect the candidate dependency graph once a package manager drops a pack-level dependsOn because the closure can change after the manager is known", async () => {
		await addCommand(baseRegistry(), "/index/registry.json", {
			items: ["button"],
		});
		expect(coreMocks.collectRegistryDependencies).toHaveBeenCalledTimes(2);
		expect(coreMocks.collectRegistryDependencies).toHaveBeenNthCalledWith(
			1,
			["button"],
			baseRegistry().items,
			{},
		);
		expect(coreMocks.collectRegistryDependencies).toHaveBeenNthCalledWith(
			2,
			["button"],
			baseRegistry().items,
			{},
			"pnpm",
		);
		expect(packagesMocks.installDeclaredPackages).toHaveBeenCalled();
	});
});

describe("addCommand condition interpolation option conflicts", () => {
	beforeEach(() => {
		for (const mock of [
			coreMocks.buildInstallPlan,
			coreMocks.collectRegistryDependencies,
			coreMocks.catalogNeedsPackageManager,
			coreMocks.setScriptExecutor,
			coreMocks.compiledItemUsesEcosystem,
		])
			mock.mockReset();
		for (const mock of [
			registryMocks.loadCompiledItems,
			filesMocks.planFileWrites,
			scriptsMocks.prepareScriptExecution,
			conditionsMocks.captureRequiredConditions,
			conditionsMocks.captureItemLocalConditionsForPlan,
		])
			mock.mockClear();
		coreMocks.catalogNeedsPackageManager.mockReturnValue(false);
		coreMocks.compiledItemUsesEcosystem.mockReturnValue(false);
		coreMocks.collectRegistryDependencies.mockReturnValue([
			{ itemId: "button", item: buttonIndexItem },
		]);
		coreMocks.buildInstallPlan.mockReturnValue([
			{ itemId: "button", sources: [] },
		]);
		registryMocks.loadCompiledItems.mockResolvedValue(new Map());
		scriptsMocks.projectScriptHelpers.mockReturnValue({});
		scriptsMocks.prepareScriptExecution.mockResolvedValue({
			trust: "untrusted" as core.RegistryTrust,
			allowInfer: false,
			allowMutation: false,
		});
		conditionsMocks.captureRequiredConditions.mockResolvedValue({});
		conditionsMocks.captureItemLocalConditionsForPlan.mockImplementation(
			async (_r, _i, _items, plan, conditions) => ({
				context: conditions,
				plan,
			}),
		);
		filesMocks.planFileWrites.mockResolvedValue({ items: [], conflicts: [] });
		filesMocks.confirmFileOverwrites.mockResolvedValue(undefined);
		packagesMocks.installDeclaredPackages.mockResolvedValue([]);
		packagesMocks.mergeProjectCommands.mockResolvedValue(undefined);
		logOutput = [];
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function registryWithConditions(
		shared: core.RegistryConditionValue[],
		itemLocal: core.RegistryConditionValue[],
	): core.Registry {
		const registry = baseRegistry();
		registry.conditions = {
			framework: {
				label: "Framework",
				kind: core.RegistryConditionKind.SELECT,
				values: shared,
			},
		};
		registry.items.button.conditions = {
			framework: {
				label: "Framework",
				kind: core.RegistryConditionKind.SELECT,
				values: itemLocal,
			},
		};
		return registry;
	}

	const conflictMessage =
		'Condition "framework" declares conflicting interpolation option values (shared conditions and "button").';

	test("it should throw when the option lists differ only in binding key counts because bindings participate in the conflict check", async () => {
		await expect(
			addCommand(
				registryWithConditions(
					[{ value: "react", label: "React", bindings: { version: "18" } }],
					[
						{
							value: "react",
							label: "React",
							bindings: { version: "18", arch: "x64" },
						},
					],
				),
				"/index/registry.json",
				{ items: ["button"] },
			),
		).rejects.toThrow(conflictMessage);
	});

	test("it should throw when the option lists have equal value and label but different binding values because a silently different binding is ambiguous", async () => {
		await expect(
			addCommand(
				registryWithConditions(
					[{ value: "react", label: "React", bindings: { version: "18" } }],
					[{ value: "react", label: "React", bindings: { version: "19" } }],
				),
				"/index/registry.json",
				{ items: ["button"] },
			),
		).rejects.toThrow(conflictMessage);
	});

	test("it should throw when only the second entries of the option lists differ because one differing entry is enough to conflict", async () => {
		await expect(
			addCommand(
				registryWithConditions(
					[
						{ value: "react", label: "React" },
						{ value: "svelte", label: "Svelte" },
					],
					[
						{ value: "react", label: "React" },
						{ value: "svelte", label: "Svelte 5" },
					],
				),
				"/index/registry.json",
				{ items: ["button"] },
			),
		).rejects.toThrow(conflictMessage);
	});

	test("it should throw when the values match but the labels differ because labels are part of the option identity", async () => {
		await expect(
			addCommand(
				registryWithConditions(
					[{ value: "react", label: "React" }],
					[{ value: "react", label: "React 18" }],
				),
				"/index/registry.json",
				{ items: ["button"] },
			),
		).rejects.toThrow(conflictMessage);
	});
});

describe("addCommand post-capture install-plan validation", () => {
	beforeEach(() => {
		for (const mock of [
			coreMocks.buildInstallPlan,
			coreMocks.collectRegistryDependencies,
			coreMocks.catalogNeedsPackageManager,
			coreMocks.setScriptExecutor,
			coreMocks.compiledItemUsesEcosystem,
		])
			mock.mockReset();
		for (const mock of [
			registryMocks.loadCompiledItems,
			filesMocks.planFileWrites,
			scriptsMocks.prepareScriptExecution,
			conditionsMocks.captureRequiredConditions,
			conditionsMocks.captureItemLocalConditionsForPlan,
		])
			mock.mockClear();
		coreMocks.catalogNeedsPackageManager.mockReturnValue(false);
		coreMocks.compiledItemUsesEcosystem.mockReturnValue(false);
		coreMocks.collectRegistryDependencies.mockReturnValue([
			{ itemId: "button", item: buttonIndexItem },
		]);
		coreMocks.buildInstallPlan.mockReturnValue([
			{ itemId: "button", sources: [] },
		]);
		registryMocks.loadCompiledItems.mockResolvedValue(new Map());
		scriptsMocks.projectScriptHelpers.mockReturnValue({});
		scriptsMocks.prepareScriptExecution.mockResolvedValue({
			trust: "untrusted" as core.RegistryTrust,
			allowInfer: false,
			allowMutation: false,
		});
		conditionsMocks.captureRequiredConditions.mockResolvedValue({});
		conditionsMocks.captureItemLocalConditionsForPlan.mockImplementation(
			async (_r, _i, _items, plan, conditions) => ({
				context: conditions,
				plan,
			}),
		);
		filesMocks.planFileWrites.mockResolvedValue({ items: [], conflicts: [] });
		filesMocks.confirmFileOverwrites.mockResolvedValue(undefined);
		packagesMocks.installDeclaredPackages.mockResolvedValue([]);
		packagesMocks.mergeProjectCommands.mockResolvedValue(undefined);
		logOutput = [];
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("it should reject the install plan again after item-local condition capture when the captured plan references an unknown item because a stale plan must never reach the write phase", async () => {
		// The plan is valid at the pre-capture check; capture mutates it to name
		// an item that is not in the registry. Only the post-capture validation
		// can catch this.
		conditionsMocks.captureItemLocalConditionsForPlan.mockImplementation(
			async (_r, _i, _items, _plan, conditions) => ({
				context: conditions,
				plan: [{ itemId: "ghost", sources: [] }],
			}),
		);

		await expect(
			addCommand(baseRegistry(), "/index/registry.json", {
				items: ["button"],
			}),
		).rejects.toThrow('Install plan references unknown registry item "ghost".');

		// A rejected plan must not produce any writes.
		expect(filesMocks.planFileWrites).not.toHaveBeenCalled();
		// The beforeWrite hook must never run against a stale plan — guards run
		// before the write phase, so the hook can never be reordered ahead of them.
		expect(coreMocks.runBeforeWriteHook).not.toHaveBeenCalled();
		// The executor reset still runs even though validation threw.
		expect(coreMocks.setScriptExecutor).toHaveBeenCalledWith(undefined);
	});
});
