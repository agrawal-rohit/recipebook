import {
	type HandlerRuntime,
	type IndexItem,
	type InstallNode,
	type Registry,
	type RegistryCondition,
	RegistryConditionKind,
	type RegistryContext,
} from "@cheetos/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	captureItemLocalConditionsForPlan,
	captureRequiredConditions,
} from "./conditions";

const promptsMocks = vi.hoisted(() => ({
	confirmInput: vi.fn(),
	multiselectInput: vi.fn(),
	selectInput: vi.fn(),
	textInput: vi.fn(),
}));
vi.mock("../cli/prompts", () => promptsMocks);

/** Handler runtime stub; infer handlers are disabled in these flows. */
function stubRuntime(): HandlerRuntime {
	return {
		projectDir: "/proj",
		isFile: vi.fn(async () => false),
		isDirectory: vi.fn(async () => false),
		readFile: vi.fn(async () => ""),
		run: vi.fn(async () => ""),
	};
}

function selectCondition(
	overrides: Partial<RegistryCondition> = {},
): RegistryCondition {
	return {
		label: "Framework",
		description: "Which framework should the component target?",
		kind: RegistryConditionKind.SELECT,
		required: true,
		values: [
			{ value: "react", label: "React" },
			{ value: "vue", label: "Vue" },
		],
		...overrides,
	};
}

const buttonItem: IndexItem = {
	title: "Button",
	description: "A button component",
	type: "component",
	source: "r/compiled/button.json",
	requires: ["framework"],
};

/** Same item without a shared-condition dependency, for single-kind flows. */
const plainButtonItem: IndexItem = {
	title: "Button",
	description: "A button component",
	type: "component",
	source: "r/compiled/button.json",
};

/** Button item that pulls the given shared conditions into the required set. */
function itemRequiring(keys: string[]): IndexItem {
	return { ...plainButtonItem, requires: keys };
}

function registryWith(
	conditions: Record<string, RegistryCondition>,
	items: Record<string, IndexItem>,
): Registry {
	return {
		types: { component: { label: "Components" } },
		items,
		conditions,
	};
}

async function captureShared(
	registry: Registry,
	options: {
		allowInfer?: boolean;
		context?: RegistryContext;
	} = {},
): Promise<RegistryContext> {
	return captureRequiredConditions(
		registry,
		"/registry/registry.json",
		"/proj",
		["button"],
		{ runtime: stubRuntime(), allowInfer: false, ...options },
	);
}

beforeEach(() => {
	for (const mock of Object.values(promptsMocks)) mock.mockReset();
	promptsMocks.confirmInput.mockResolvedValue(true);
	promptsMocks.selectInput.mockResolvedValue("react");
	promptsMocks.multiselectInput.mockResolvedValue(["react"]);
	promptsMocks.textInput.mockResolvedValue("my-app");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("captureRequiredConditions", () => {
	test("it should prompt for a required select and store the answer because the install plan needs the condition value to select packs", async () => {
		const context = await captureShared(
			registryWith({ framework: selectCondition() }, { button: buttonItem }),
		);

		expect(context).toEqual({ framework: "react" });
		expect(promptsMocks.selectInput).toHaveBeenCalledTimes(1);
		expect(promptsMocks.selectInput).toHaveBeenCalledWith(
			"Which framework should the component target?",
			{
				options: [
					{ label: "React", value: "react" },
					{ label: "Vue", value: "vue" },
				],
			},
			undefined,
		);
	});

	test("it should leave an optional select unset when the user picks the reserved skip value because skipping must not seed a condition value", async () => {
		promptsMocks.selectInput.mockResolvedValue("None");

		const context = await captureShared(
			registryWith(
				{ framework: selectCondition({ required: undefined }) },
				{ button: buttonItem },
			),
		);

		expect(context).toEqual({});
		const options = promptsMocks.selectInput.mock.calls[0][1].options;
		expect(options).toContainEqual({ label: "None", value: "None" });
	});

	test("it should auto-select a required single-value condition without prompting because asking is pointless when one legal value exists", async () => {
		const context = await captureShared(
			registryWith(
				{
					framework: selectCondition({
						values: [{ value: "react", label: "React" }],
					}),
				},
				{ button: buttonItem },
			),
		);

		expect(context).toEqual({ framework: "react" });
		expect(promptsMocks.selectInput).not.toHaveBeenCalled();
	});

	test("it should reject an optional select that declares the reserved skip value because 'None' must stay available for skipping", async () => {
		await expect(
			captureShared(
				registryWith(
					{
						framework: selectCondition({
							required: undefined,
							values: [{ value: "None", label: "None" }],
						}),
					},
					{ button: buttonItem },
				),
			),
		).rejects.toThrow(/is reserved for skipping non-required selects/);
	});

	test("it should capture a required boolean through the confirm prompt because yes/no is the natural interaction", async () => {
		promptsMocks.confirmInput.mockResolvedValue(true);

		const context = await captureShared(
			registryWith(
				{
					logging: selectCondition({
						label: "Logging",
						kind: RegistryConditionKind.BOOLEAN,
						description: "Enable verbose logging?",
						values: [],
					}),
				},
				{ button: itemRequiring(["logging"]) },
			),
		);

		expect(context).toEqual({ logging: true });
		expect(promptsMocks.confirmInput).toHaveBeenCalledTimes(1);
		expect(promptsMocks.confirmInput).toHaveBeenCalledWith(
			"Enable verbose logging?",
			{},
			undefined,
		);
	});

	test("it should leave an optional boolean unset when the user answers None because confirm cannot represent unset", async () => {
		promptsMocks.selectInput.mockResolvedValue("None");

		const context = await captureShared(
			registryWith(
				{
					logging: selectCondition({
						kind: RegistryConditionKind.BOOLEAN,
						required: undefined,
						values: [],
					}),
				},
				{ button: itemRequiring(["logging"]) },
			),
		);

		expect(context).toEqual({});
		expect(promptsMocks.selectInput).toHaveBeenCalledWith(
			expect.any(String),
			{
				options: [
					{ label: "Yes", value: "true" },
					{ label: "No", value: "false" },
					{ label: "None", value: "None" },
				],
			},
			undefined,
		);
	});

	test("it should capture an optional boolean false when the user answers No because false is a real answer, not a skip", async () => {
		promptsMocks.selectInput.mockResolvedValue("false");

		const context = await captureShared(
			registryWith(
				{
					logging: selectCondition({
						kind: RegistryConditionKind.BOOLEAN,
						required: undefined,
						values: [],
					}),
				},
				{ button: itemRequiring(["logging"]) },
			),
		);

		expect(context).toEqual({ logging: false });
	});

	test("it should prompt for required text and store the trimmed answer because text conditions have no fixed options", async () => {
		const context = await captureShared(
			registryWith(
				{
					appName: selectCondition({
						label: "App name",
						kind: RegistryConditionKind.TEXT,
						description: "What is the app called?",
						values: [],
					}),
				},
				{
					button: itemRequiring(["appName"]),
				},
			),
		);

		expect(context).toEqual({ appName: "my-app" });
		expect(promptsMocks.textInput).toHaveBeenCalledWith(
			"What is the app called?",
			{ required: true },
			undefined,
		);
	});

	test("it should leave optional text unset on an empty answer because an empty string means the user does not care", async () => {
		promptsMocks.textInput.mockResolvedValue("");

		const context = await captureShared(
			registryWith(
				{
					appName: selectCondition({
						kind: RegistryConditionKind.TEXT,
						required: undefined,
						values: [],
					}),
				},
				{
					button: itemRequiring(["appName"]),
				},
			),
		);

		expect(context).toEqual({});
	});

	test("it should capture a required multiselect as an array because multiple values must reach pack selection together", async () => {
		promptsMocks.multiselectInput.mockResolvedValue(["react", "vue"]);

		const context = await captureShared(
			registryWith(
				{
					framework: selectCondition({
						kind: RegistryConditionKind.MULTISELECT,
						description: "Which frameworks should be supported?",
					}),
				},
				{ button: buttonItem },
			),
		);

		expect(context).toEqual({ framework: ["react", "vue"] });
		expect(promptsMocks.multiselectInput).toHaveBeenCalledWith(
			"Which frameworks should be supported?",
			{
				options: [
					{ label: "React", value: "react" },
					{ label: "Vue", value: "vue" },
				],
			},
			undefined,
		);
	});

	test("it should leave an optional multiselect unset on an empty selection because selecting nothing is a skip", async () => {
		promptsMocks.multiselectInput.mockResolvedValue([]);

		const context = await captureShared(
			registryWith(
				{
					framework: selectCondition({
						kind: RegistryConditionKind.MULTISELECT,
						required: undefined,
					}),
				},
				{ button: buttonItem },
			),
		);

		expect(context).toEqual({});
	});

	test("it should confirm an inferred select default and accept it without re-prompting because showing the detected value avoids a needless choice", async () => {
		const context = await captureShared(
			registryWith(
				{ framework: selectCondition({ default: "react" }) },
				{ button: buttonItem },
			),
			{ allowInfer: true },
		);

		expect(context).toEqual({ framework: "react" });
		expect(promptsMocks.confirmInput).toHaveBeenCalledTimes(1);
		expect(promptsMocks.confirmInput).toHaveBeenCalledWith(
			expect.stringMatching(/Detected .*React.* for .*Framework.* Use this\?/u),
			{},
			true,
		);
		expect(promptsMocks.selectInput).not.toHaveBeenCalled();
	});

	test("it should fall back to the full select prompt with the inferred default preselected when the user declines the inferred value because the answer must still be the user's", async () => {
		promptsMocks.confirmInput.mockResolvedValue(false);
		promptsMocks.selectInput.mockResolvedValue("vue");

		const context = await captureShared(
			registryWith(
				{ framework: selectCondition({ default: "react" }) },
				{ button: buttonItem },
			),
			{ allowInfer: true },
		);

		expect(context).toEqual({ framework: "vue" });
		expect(promptsMocks.selectInput).toHaveBeenCalledWith(
			"Which framework should the component target?",
			expect.anything(),
			"react",
		);
	});

	test("it should keep prompting later waves for conditions whose `when` became satisfied because gating must re-collect pending conditions after each batch", async () => {
		// Wave 1: framework select (item `requires`). Wave 2: the boolean gated on it,
		// which enters the required set through the pack `when` that uses it.
		const chattyItem: IndexItem = {
			...buttonItem,
			packs: [
				{
					id: "chatty",
					title: "Chatty build",
					when: { verbose: true },
					source: "r/compiled/button-chatty.json",
				},
			],
		};
		const context = await captureShared(
			registryWith(
				{
					framework: selectCondition(),
					verbose: selectCondition({
						label: "Verbose",
						kind: RegistryConditionKind.BOOLEAN,
						description: "Enable verbose output?",
						required: true,
						values: [],
						when: { framework: "react" },
					}),
				},
				{ button: chattyItem },
			),
		);

		expect(context).toEqual({ framework: "react", verbose: true });
		expect(promptsMocks.selectInput).toHaveBeenCalledTimes(1);
		expect(promptsMocks.confirmInput).toHaveBeenCalledTimes(1);
		expect(promptsMocks.confirmInput).toHaveBeenCalledWith(
			"Enable verbose output?",
			{},
			undefined,
		);
	});
});

describe("captureItemLocalConditionsForPlan", () => {
	const cardItem: IndexItem = {
		title: "Card",
		description: "A card component",
		type: "component",
		conditions: {
			size: selectCondition({
				label: "Card size",
				description: "Which card size should be installed?",
				values: [
					{ value: "sm", label: "Small" },
					{ value: "lg", label: "Large" },
				],
			}),
		},
		packs: [
			{
				id: "sm",
				title: "Small card",
				when: { size: "sm" },
				source: "r/compiled/card-sm.json",
			},
			{
				id: "lg",
				title: "Large card",
				when: { size: "lg" },
				source: "r/compiled/card-lg.json",
			},
		],
	};

	test("it should capture an item-local condition and rebuild the plan when the answer selects a pack because the pack `when` uses the captured key", async () => {
		promptsMocks.selectInput.mockResolvedValue("sm");
		const registry = registryWith({}, { card: cardItem });
		const plan: InstallNode[] = [{ itemId: "card", sources: [] }];

		const result = await captureItemLocalConditionsForPlan(
			registry,
			"/registry/registry.json",
			["card"],
			plan,
			{},
			stubRuntime(),
			{ allowInfer: false },
		);

		expect(result.context).toEqual({ size: "sm" });
		expect(result.plan[0]?.sources).toContain("r/compiled/card-sm.json");
		expect(promptsMocks.selectInput).toHaveBeenCalledTimes(1);
		expect(promptsMocks.selectInput).toHaveBeenCalledWith(
			"Which card size should be installed?",
			{
				options: [
					{ label: "Small", value: "sm" },
					{ label: "Large", value: "lg" },
				],
			},
			undefined,
		);
	});

	test("it should return the plan untouched when the captured key is not used by any pack `when` because interpolation-only locals cannot change pack selection", async () => {
		const plainItem: IndexItem = {
			title: "Badge",
			description: "A badge component",
			type: "component",
			conditions: {
				variant: selectCondition({
					label: "Variant",
					description: "Which variant?",
				}),
			},
		};
		const registry = registryWith({}, { badge: plainItem });
		const plan: InstallNode[] = [{ itemId: "badge", sources: [] }];

		const result = await captureItemLocalConditionsForPlan(
			registry,
			"/registry/registry.json",
			["badge"],
			plan,
			{},
			stubRuntime(),
			{ allowInfer: false },
		);

		expect(result.context).toEqual({ variant: "react" });
		expect(result.plan).toBe(plan);
	});
});
