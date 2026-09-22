import { styleText } from "node:util";
import { confirm, multiselect, select, text } from "@clack/prompts";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { OperationCanceledError } from "./errors";
import {
	confirmInput,
	groupedSelectInput,
	multiselectInput,
	selectInput,
	textInput,
} from "./prompts";

/**
 * Shared mock state. The `@clack/*` factories are hoisted above the imports, so
 * every controllable knob lives here and the factories close over it.
 */
const mockState = vi.hoisted(() => ({
	/** Sentinel cancel symbol; `isCancel` only recognizes this value. */
	cancel: Symbol("cancel"),
	textResult: undefined as unknown,
	selectResult: undefined as unknown,
	multiResult: undefined as unknown,
	confirmResult: undefined as unknown,
	/** Terminal height returned by the mocked `getRows`. */
	getRowsValue: 40,
	/** Replacement for clack's wrapper; default prepends the prefix per line. */
	wrapBehavior: null as null | ((text: string, prefix: string) => string),
	/** Configs captured from every fake `SelectPrompt` construction. */
	selectPromptConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@clack/prompts", () => ({
	text: vi.fn(() => mockState.textResult),
	select: vi.fn(() => mockState.selectResult),
	multiselect: vi.fn(() => mockState.multiResult),
	confirm: vi.fn(() => mockState.confirmResult),
	isCancel: (value: unknown) => value === mockState.cancel,
	symbol: vi.fn(() => "!"),
	S_BAR: "|",
	S_BAR_END: "<",
	S_RADIO_ACTIVE: "(o)",
	S_RADIO_INACTIVE: "( )",
}));

vi.mock("@clack/core", () => ({
	SelectPrompt: class {
		constructor(config: Record<string, unknown>) {
			mockState.selectPromptConfigs.push(config);
		}
		prompt() {
			return mockState.selectResult;
		}
	},
	getRows: () => mockState.getRowsValue,
	wrapTextWithPrefix: (
		_stdout: unknown,
		text: string,
		prefix: string,
	): string =>
		mockState.wrapBehavior === null
			? // Mimic clack: every wrapped line carries the prefix.
				text
					.split("\n")
					.map((line) => prefix + line)
					.join("\n")
			: mockState.wrapBehavior(text, prefix),
}));

const options = [
	{ value: "a", label: "A" },
	{ value: "b", label: "B" },
];

beforeEach(() => {
	vi.clearAllMocks();
	mockState.textResult = undefined;
	mockState.selectResult = undefined;
	mockState.multiResult = undefined;
	mockState.confirmResult = undefined;
	mockState.getRowsValue = 40;
	mockState.wrapBehavior = null;
	mockState.selectPromptConfigs = [];
});

describe("selectInput", () => {
	test("it should reject an empty option list before prompting because a select with nothing to choose is a caller bug", async () => {
		await expect(selectInput("pick", { options: [] })).rejects.toThrowError(
			'Select prompt "pick" has no options.',
		);
		expect(select).not.toHaveBeenCalled();
	});

	test("it should reject a default that is not offered because preselecting an absent value is a caller bug", async () => {
		await expect(selectInput("pick", { options }, "z")).rejects.toThrowError(
			'Select prompt "pick" has an unexpected default value.',
		);
		expect(select).not.toHaveBeenCalled();
	});

	test("it should return the selected value and forward options plus initialValue because clack renders the caller's list", async () => {
		mockState.selectResult = "b";
		await expect(selectInput("pick", { options }, "a")).resolves.toBe("b");
		expect(vi.mocked(select).mock.calls[0][0]).toEqual({
			message: "pick",
			options,
			initialValue: "a",
		});
	});

	test("it should omit initialValue when no default is given because clack should pick its own default", async () => {
		mockState.selectResult = "a";
		await selectInput("pick", { options });
		expect(vi.mocked(select).mock.calls[0][0]).not.toHaveProperty(
			"initialValue",
		);
	});

	test("it should translate the clack cancel symbol into OperationCanceledError because callers handle one cancellation type", async () => {
		mockState.selectResult = mockState.cancel;
		await expect(selectInput("pick", { options })).rejects.toBeInstanceOf(
			OperationCanceledError,
		);
	});

	test("it should reject a result outside the offered values because the prompt must never leak a foreign value", async () => {
		mockState.selectResult = "z";
		await expect(selectInput("pick", { options })).rejects.toThrowError(
			'Select prompt "pick" returned an unexpected value.',
		);
	});

	test("it should tolerate duplicate option values because the allowed set collapses them", async () => {
		mockState.selectResult = "a";
		await expect(
			selectInput("pick", {
				options: [{ value: "a" }, { value: "a", label: "A2" }],
			}),
		).resolves.toBe("a");
	});

	test("it should reject a non-string result because the narrowing guard is type-safe", async () => {
		mockState.selectResult = 42;
		await expect(selectInput("pick", { options })).rejects.toThrowError(
			'Select prompt "pick" returned an unexpected value.',
		);
	});
});

describe("multiselectInput", () => {
	test("it should reject an empty option list before prompting because a multiselect with nothing to choose is a caller bug", async () => {
		await expect(
			multiselectInput("pick", { options: [] }),
		).rejects.toThrowError('Select prompt "pick" has no options.');
		expect(multiselect).not.toHaveBeenCalled();
	});

	test("it should reject any default that is not offered because preselecting an absent value is a caller bug", async () => {
		await expect(
			multiselectInput("pick", { options }, ["z"]),
		).rejects.toThrowError(
			'Select prompt "pick" has an unexpected default value.',
		);
	});

	test("it should return the selected values and forward initialValues because clack preselects the caller's defaults", async () => {
		mockState.multiResult = ["b"];
		await expect(multiselectInput("pick", { options }, ["a"])).resolves.toEqual(
			["b"],
		);
		expect(vi.mocked(multiselect).mock.calls[0][0]).toMatchObject({
			message: "pick",
			initialValues: ["a"],
		});
	});

	test("it should reject a result entry outside the offered values because the narrowing guard is type-safe", async () => {
		mockState.multiResult = ["a", "z"];
		await expect(multiselectInput("pick", { options })).rejects.toThrowError(
			'Multiselect prompt "pick" returned an unexpected value.',
		);
	});

	test("it should reject a non-array result because the narrowing guard is type-safe", async () => {
		mockState.multiResult = "a";
		await expect(multiselectInput("pick", { options })).rejects.toThrowError(
			'Multiselect prompt "pick" returned an unexpected value.',
		);
	});

	test("it should translate the clack cancel symbol into OperationCanceledError because callers handle one cancellation type", async () => {
		mockState.multiResult = mockState.cancel;
		await expect(multiselectInput("pick", { options })).rejects.toBeInstanceOf(
			OperationCanceledError,
		);
	});

	test("it should forward an empty defaults array as initialValues because only undefined means no defaults", async () => {
		mockState.multiResult = [];
		await multiselectInput("pick", { options }, []);
		expect(vi.mocked(multiselect).mock.calls[0][0]).toHaveProperty(
			"initialValues",
			[],
		);
	});
});

describe("textInput", () => {
	test("it should trim surrounding whitespace because users add stray spaces", async () => {
		mockState.textResult = "  x  ";
		await expect(textInput("name")).resolves.toBe("x");
	});

	test("it should wire the required validator because empty input must be rejected in-prompt", async () => {
		mockState.textResult = "x";
		await textInput("name", { required: true });
		const arg = vi.mocked(text).mock.calls[0][0] as {
			validate?: (value: string) => string | undefined;
		};
		expect(arg.validate?.("")).toBe("A value is required");
		expect(arg.validate?.("   ")).toBe("A value is required");
		expect(arg.validate?.("x")).toBeUndefined();
	});

	test("it should forward defaultValue as both initialValue and defaultValue because clack preselects and echoes it", async () => {
		mockState.textResult = "typed";
		await textInput("name", {}, "d");
		expect(vi.mocked(text).mock.calls[0][0]).toMatchObject({
			initialValue: "d",
			defaultValue: "d",
		});
	});

	test("it should forward the placeholder only when defined because clack distinguishes absent placeholders", async () => {
		mockState.textResult = "typed";
		await textInput("name", { placeholder: "p" });
		expect(vi.mocked(text).mock.calls[0][0]).toMatchObject({
			placeholder: "p",
		});

		await textInput("name");
		expect(vi.mocked(text).mock.calls[1][0]).not.toHaveProperty("placeholder");
	});

	test("it should translate the clack cancel symbol into OperationCanceledError because callers handle one cancellation type", async () => {
		mockState.textResult = mockState.cancel;
		await expect(textInput("name")).rejects.toBeInstanceOf(
			OperationCanceledError,
		);
	});

	test("it should reject a non-string result because the type guard protects callers", async () => {
		mockState.textResult = 9;
		await expect(textInput("name")).rejects.toThrowError(
			'Text prompt "name" returned a non-string value.',
		);
	});
});

describe("confirmInput", () => {
	test("it should forward active, inactive, and initialValue options and return the boolean because confirm is pass-through", async () => {
		mockState.confirmResult = true;
		await expect(
			confirmInput("sure?", { active: "y", inactive: "n" }, false),
		).resolves.toBe(true);
		expect(vi.mocked(confirm).mock.calls[0][0]).toMatchObject({
			active: "y",
			inactive: "n",
			initialValue: false,
		});
	});

	test("it should reject a non-boolean result because the type guard protects callers", async () => {
		mockState.confirmResult = "yes";
		await expect(confirmInput("sure?")).rejects.toThrowError(
			'Confirm prompt "sure?" returned a non-boolean value.',
		);
	});

	test("it should translate the clack cancel symbol into OperationCanceledError because callers handle one cancellation type", async () => {
		mockState.confirmResult = mockState.cancel;
		await expect(confirmInput("sure?")).rejects.toBeInstanceOf(
			OperationCanceledError,
		);
	});
});

describe("groupedSelectInput", () => {
	/**
	 * Build the prompt (awaited; the fake resolves immediately) and render the
	 * captured config with the given cursor. `availableLines` inside render is
	 * `getRows − title(3) − footer(2) − 1`.
	 */
	async function render(
		options: Record<string, Array<{ value: string; label?: string }>>,
		cursor: number,
	): Promise<string> {
		mockState.selectResult = options[Object.keys(options)[0]][0].value;
		await groupedSelectInput("pick", options);
		const config = mockState.selectPromptConfigs.at(-1) as Record<
			string,
			unknown
		>;
		const render = config.render as (this: {
			state: string;
			cursor: number;
		}) => string;
		return render.call({ state: "initial", cursor });
	}

	test("it should reject groups with no options because a prompt with nothing to choose is a caller bug", async () => {
		await expect(groupedSelectInput("pick", { g: [] })).rejects.toThrowError(
			'Select prompt "pick" has no options.',
		);
		await expect(groupedSelectInput("pick", {})).rejects.toThrowError(
			'Select prompt "pick" has no options.',
		);
	});

	test("it should flatten groups into disabled header rows followed by enabled options because clack renders one row list", async () => {
		mockState.selectResult = "a1";
		await groupedSelectInput("pick", {
			Alpha: [{ value: "a1" }, { value: "a2" }],
			Beta: [{ value: "b1" }],
		});
		const config = mockState.selectPromptConfigs.at(-1) as {
			options: Array<{
				value: string;
				label?: string;
				group: unknown;
				disabled?: boolean;
			}>;
			initialValue?: string;
		};
		expect(config.options).toEqual([
			{ value: "Alpha", label: "Alpha", group: true, disabled: true },
			{ value: "a1", group: "Alpha", disabled: false },
			{ value: "a2", group: "Alpha", disabled: false },
			{ value: "Beta", label: "Beta", group: true, disabled: true },
			{ value: "b1", group: "Beta", disabled: false },
		]);
		expect(config.initialValue).toBe("a1");
	});

	test("it should return the chosen offered value because the result must be an offered option", async () => {
		mockState.selectResult = "a1";
		await expect(
			groupedSelectInput("pick", { Alpha: [{ value: "a1" }] }),
		).resolves.toBe("a1");
	});

	test("it should reject a result outside the offered values because the narrowing guard is type-safe", async () => {
		mockState.selectResult = "z";
		await expect(
			groupedSelectInput("pick", { Alpha: [{ value: "a1" }] }),
		).rejects.toThrowError(
			'Select prompt "pick" returned an unexpected value.',
		);
	});

	test("it should translate the clack cancel symbol into OperationCanceledError because callers handle one cancellation type", async () => {
		mockState.selectResult = mockState.cancel;
		await expect(
			groupedSelectInput("pick", { Alpha: [{ value: "a1" }] }),
		).rejects.toBeInstanceOf(OperationCanceledError);
	});

	test("it should render group headers, radio glyphs, end-of-group markers, and the navigation footer because the grouped layout must stay legible", async () => {
		const out = await render(
			{ Alpha: [{ value: "a1" }, { value: "a2" }], Beta: [{ value: "b1" }] },
			1,
		);
		expect(out).toContain("Alpha");
		expect(out).toContain("Beta");
		// Active option row uses the active radio glyph; the rest use the inactive one.
		expect(out).toContain(styleText("green", "(o)"));
		expect(out).toContain(styleText("dim", "( )"));
		// Last option of each group is prefixed with the bar-end glyph.
		expect(out).toContain(styleText("dim", "< "));
		// Footer advertises navigation.
		expect(out).toContain("↑/↓");
	});

	test("it should render wrapped rows with the continuation prefix and trimmed break whitespace because wrapped lines must align", async () => {
		mockState.wrapBehavior = (text: string, prefix: string) =>
			`${prefix}${text}\n${prefix}   wrapped-body`;
		const out = await render({ Alpha: [{ value: "a1" }, { value: "a2" }] }, 0);
		const barContinuation = `${styleText("dim", "|")}   `;
		// Non-last rows continue with the dim bar prefix and a trimmed body.
		expect(out).toContain(`${barContinuation}wrapped-body`);
		// Last row of the only group continues with plain spaces.
		expect(out).toContain("    wrapped-body");
	});

	test("it should hide overflow rows behind dim ellipsis markers and keep the active row visible because scrolling must never lose the cursor", async () => {
		mockState.getRowsValue = 10; // availableLines = 4
		const out = await render(
			{
				HeaderGroup: [
					{ value: "opt-1" },
					{ value: "opt-2" },
					{ value: "opt-3" },
				],
			},
			3, // cursor on the last option of three
		);
		expect(out).toContain(styleText("dim", "..."));
		expect(out).toContain("opt-3");
		expect(out).not.toContain("HeaderGroup");
	});

	test("it should show both overflow markers while keeping the first option visible when the window truncates the middle", async () => {
		// 1 header (2 lines) + 5 options; availableLines = 5.
		mockState.getRowsValue = 11;
		const out = await render(
			{
				HeaderGroup: [
					{ value: "opt-1" },
					{ value: "opt-2" },
					{ value: "opt-3" },
					{ value: "opt-4" },
					{ value: "opt-5" },
				],
			},
			1,
		);
		expect(out).toContain(styleText("dim", "..."));
		expect(out).toContain("opt-1");
	});

	test("it should keep the active row visible even at minimum capacity because the window must never lose the cursor", async () => {
		// RED: windowRows currently shows row 3 for cursor 1 at availableLines 1,
		// hiding the active row despite the documented invariant.
		mockState.getRowsValue = 7; // availableLines = 1
		const out = await render(
			{
				HeaderGroup: [
					{ value: "opt-1" },
					{ value: "opt-2" },
					{ value: "opt-3" },
				],
			},
			1,
		);
		expect(out).toContain("opt-1");
	});
});
