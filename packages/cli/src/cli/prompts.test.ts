import { beforeEach, describe, expect, test, vi } from "vitest";
import { OperationCanceledError } from "./errors";
import {
	confirmInput,
	groupedSelectInput,
	multiselectInput,
	selectInput,
	textInput,
} from "./prompts";

/** Captured shape of the SelectPrompt config groupedSelectInput builds. */
type CapturedSelectConfig = {
	options: Array<Record<string, unknown>>;
	initialValue?: string;
	render: (this: { state: string; cursor: number }) => string;
};

/** Mocked @clack/core — groupedSelectInput drives a SelectPrompt instance. */
const clackCoreMocks = vi.hoisted(() => {
	const state: {
		lastConfig?: CapturedSelectConfig;
		promptResult: unknown;
	} = { promptResult: undefined };

	class SelectPromptMock {
		constructor(config: CapturedSelectConfig) {
			state.lastConfig = config;
		}
		prompt(): Promise<unknown> {
			return Promise.resolve(state.promptResult);
		}
	}

	return {
		state,
		SelectPrompt: SelectPromptMock,
		getRows: vi.fn((): number => 40),
		// Mirrors the real prefixing contract: every wrapped line carries its prefix.
		wrapTextWithPrefix: vi.fn(
			(
				_stdout: unknown,
				text: string,
				startPrefix: string,
				continuationPrefix = startPrefix,
			) =>
				text
					.split("\n")
					.map((line, index) =>
						index === 0 ? startPrefix + line : continuationPrefix + line,
					)
					.join("\n"),
		),
	};
});

vi.mock("@clack/core", () => clackCoreMocks);

/** Mocked @clack/prompts — the IO (terminal) boundary of the wrappers. */
const clackMocks = vi.hoisted(() => ({
	cancelSymbol: Symbol("cancel"),
	text: vi.fn(),
	select: vi.fn(),
	multiselect: vi.fn(),
	confirm: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
	// Wrapper-internal render symbols (used only by groupedSelectInput); not tested.
	S_BAR: "│",
	S_BAR_END: "└",
	S_RADIO_ACTIVE: "◉",
	S_RADIO_INACTIVE: "○",
	symbol: () => "",
	isCancel: (value: unknown) => value === clackMocks.cancelSymbol,
	text: clackMocks.text,
	select: clackMocks.select,
	multiselect: clackMocks.multiselect,
	confirm: clackMocks.confirm,
}));

function useTty(tty: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", {
		configurable: true,
		value: tty,
	});
}

const offeredOptions = [
	{ label: "React", value: "react" },
	{ label: "Vue", value: "vue" },
];

beforeEach(() => {
	useTty(true);
	for (const mock of [
		clackMocks.text,
		clackMocks.select,
		clackMocks.multiselect,
		clackMocks.confirm,
	])
		mock.mockReset();
	clackCoreMocks.state.lastConfig = undefined;
	clackCoreMocks.state.promptResult = undefined;
	clackCoreMocks.getRows.mockReset();
	clackCoreMocks.getRows.mockReturnValue(40);
	clackCoreMocks.wrapTextWithPrefix.mockClear();
});

describe("non-interactive stdin guard", () => {
	test("it should throw before calling @clack when stdin is not a TTY", async () => {
		useTty(false);
		await expect(
			selectInput("Which?", { options: offeredOptions }),
		).rejects.toThrow(/not an interactive terminal/);
		expect(clackMocks.select).not.toHaveBeenCalled();
	});

	test("it should call @clack when stdin is a TTY", async () => {
		clackMocks.text.mockResolvedValue("widget");
		expect(await textInput("Name")).toBe("widget");
		expect(clackMocks.text).toHaveBeenCalledOnce();
	});
});

describe("cancel translation", () => {
	test("it should translate a clack cancel symbol into OperationCanceledError", async () => {
		clackMocks.select.mockResolvedValue(clackMocks.cancelSymbol);
		await expect(
			selectInput("Which?", { options: offeredOptions }),
		).rejects.toBeInstanceOf(OperationCanceledError);
	});

	test("it should translate a cancel symbol the same way for a text prompt", async () => {
		clackMocks.text.mockResolvedValue(clackMocks.cancelSymbol);
		await expect(textInput("Name")).rejects.toBeInstanceOf(
			OperationCanceledError,
		);
	});
});

describe("select value validation", () => {
	test("it should return an offered select value unchanged", async () => {
		clackMocks.select.mockResolvedValue("vue");
		expect(await selectInput("Which?", { options: offeredOptions })).toBe(
			"vue",
		);
	});

	test("it should reject a select result that is not an offered option", async () => {
		clackMocks.select.mockResolvedValue("svelte");
		await expect(
			selectInput("Which?", { options: offeredOptions }),
		).rejects.toThrow(/returned an unexpected value/);
	});

	test("it should reject an unoffered default before prompting", async () => {
		await expect(
			selectInput("Which?", { options: offeredOptions }, "svelte"),
		).rejects.toThrow(/has an unexpected default value/);
		expect(clackMocks.select).not.toHaveBeenCalled();
	});

	test("it should reject a multiselect result containing an unoffered option", async () => {
		clackMocks.multiselect.mockResolvedValue(["react", "svelte"]);
		await expect(
			multiselectInput("Which?", { options: offeredOptions }),
		).rejects.toThrow(/returned an unexpected value/);
	});
});

describe("prompt option pass-through and result validation", () => {
	test("it should forward placeholder, initial value, and required flag to the text prompt because callers configure the underlying widget", async () => {
		clackMocks.text.mockResolvedValue("widget");
		await textInput(
			"Name",
			{ placeholder: "Type here", required: true },
			"prefill",
		);

		expect(clackMocks.text).toHaveBeenCalledWith(
			expect.objectContaining({
				placeholder: "Type here",
				initialValue: "prefill",
				defaultValue: "prefill",
			}),
		);
	});

	test("it should forward an omitted placeholder and default as absent keys because the widget must not see undefined fields", async () => {
		clackMocks.text.mockResolvedValue("widget");
		await textInput("Name");

		const call = clackMocks.text.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(call).not.toHaveProperty("placeholder");
		expect(call).not.toHaveProperty("initialValue");
	});

	test("it should reject a non-string text result because the wrapper must return a string", async () => {
		clackMocks.text.mockResolvedValue(42);
		await expect(textInput("Name")).rejects.toThrowError(
			'Text prompt "Name" returned a non-string value.',
		);
	});

	test("it should wire an unoffered multiselect default into the prompt options after validating it because defaults must be checked before prompting", async () => {
		clackMocks.multiselect.mockResolvedValue(["react", "vue"]);
		await expect(
			multiselectInput("Which?", { options: offeredOptions }, ["react"]),
		).resolves.toEqual(["react", "vue"]);

		expect(clackMocks.multiselect).toHaveBeenCalledWith(
			expect.objectContaining({ initialValues: ["react"] }),
		);
	});

	test("it should return the boolean confirm result because true and false are both real answers", async () => {
		clackMocks.confirm.mockResolvedValue(true);
		await expect(confirmInput("Sure?")).resolves.toBe(true);

		clackMocks.confirm.mockResolvedValue(false);
		await expect(confirmInput("Sure?", { active: "yes" }, false)).resolves.toBe(
			false,
		);
		expect(clackMocks.confirm).toHaveBeenLastCalledWith(
			expect.objectContaining({ active: "yes", initialValue: false }),
		);
	});

	test("it should wire an offered select default as the initial value and return the selection because the prompt must open preselected", async () => {
		clackMocks.select.mockResolvedValue("vue");
		await expect(
			selectInput("Which?", { options: offeredOptions }, "vue"),
		).resolves.toBe("vue");
		expect(clackMocks.select).toHaveBeenCalledWith(
			expect.objectContaining({ initialValue: "vue" }),
		);
	});

	test("it should keep the initial value unset when no default is given because the widget then applies its own default", async () => {
		clackMocks.select.mockResolvedValue("vue");
		await selectInput("Which?", { options: offeredOptions });

		expect(clackMocks.select).toHaveBeenCalledWith(
			expect.not.objectContaining({ initialValue: expect.anything() }),
		);
	});
});

describe("text handling", () => {
	test("it should trim the returned text value", async () => {
		clackMocks.text.mockResolvedValue("  widget  \n");
		expect(await textInput("Name")).toBe("widget");
	});

	test("it should wire a validate that rejects blank input when required", async () => {
		clackMocks.text.mockImplementation(
			async (opts: { validate?: (value: string) => string | undefined }) => {
				expect(opts.validate?.("   ")).toBe("A value is required");
				expect(opts.validate?.("ok")).toBeUndefined();
				return "";
			},
		);
		await textInput("Name", { required: true });
	});

	test("it should reject a non-boolean confirm result", async () => {
		clackMocks.confirm.mockResolvedValue("yes");
		await expect(confirmInput("Sure?")).rejects.toThrow(/non-boolean value/);
	});
});

describe("groupedSelectInput", () => {
	/** Two-group option map used by most tests in this describe. */
	const groupedOptions = {
		Components: [{ value: "react", label: "React", hint: "Library" }],
		Tools: [{ value: "vitest", label: "Vitest" }],
	};

	test("it should flatten groups into header and item rows with the first item preselected because the flat SelectPrompt needs both shapes", async () => {
		clackCoreMocks.state.promptResult = "react";
		await groupedSelectInput("Which?", groupedOptions);

		const config = clackCoreMocks.state.lastConfig as CapturedSelectConfig;
		expect(config.options).toEqual([
			{
				value: "Components",
				label: "Components",
				group: true,
				disabled: true,
			},
			{
				value: "react",
				label: "React",
				hint: "Library",
				group: "Components",
				disabled: false,
			},
			{ value: "Tools", label: "Tools", group: true, disabled: true },
			{ value: "vitest", label: "Vitest", group: "Tools", disabled: false },
		]);
		expect(config.initialValue).toBe("react");
	});

	test("it should render group headers, item rows, and the footer hints because the frame must present the grouped list", async () => {
		clackCoreMocks.state.promptResult = "react";
		await groupedSelectInput("Which component?", groupedOptions);

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		const output = render.call({ state: "initial", cursor: 1 });

		expect(output).toContain("Which component?");
		expect(output).toContain("Components");
		expect(output).toContain("React");
		expect(output).toContain("Vitest");
		expect(output).toContain("to navigate");
		expect(output).toContain("Enter:");
	});

	test("it should window the row list around the cursor with overflow markers when the terminal is short because long lists cannot fit", async () => {
		clackCoreMocks.state.promptResult = "e5";
		const manyGroups = {
			Group: [1, 2, 3, 4, 5, 6].map((n) => ({
				value: `e${n}`,
				label: `Entry ${n}`,
			})),
		};
		// 8 rows + 2 title lines + 2 footer lines + 1 spare line: only the cursor row fits.
		clackCoreMocks.getRows.mockReturnValue(6);
		await groupedSelectInput("Pick", manyGroups);

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		const output = render.call({ state: "initial", cursor: 5 });

		expect(output).toContain("Entry 5");
		expect(output).not.toContain("Entry 1");
		expect(output).not.toContain("Entry 6");
		// Overflow markers above and below the single visible row.
		expect(output.match(/\.\.\./g)?.length).toBe(2);
	});

	test("it should show a leading overflow marker when the window starts below the first row because hidden rows above the cursor must be indicated", async () => {
		clackCoreMocks.state.promptResult = "e6";
		const manyGroups = {
			Group: [1, 2, 3, 4, 5, 6].map((n) => ({
				value: `e${n}`,
				label: `Entry ${n}`,
			})),
		};
		// 8 rows total (header + 6 entries + title 2 + footer 2): a 12-line terminal leaves a
		// 7-row budget, so capacity 6 (5 entries + leading marker) hides Entry 1 above the window.
		clackCoreMocks.getRows.mockReturnValue(12);
		await groupedSelectInput("Pick", manyGroups);

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		const output = render.call({ state: "initial", cursor: 5 });

		expect(output).toContain("Entry 6");
		expect(output).not.toContain("Entry 1");
		// Exactly one marker, and it leads the window (hidden rows are only above).
		expect(output.match(/\.\.\./g)?.length).toBe(1);
		const lines = output.split("\n");
		const leading = lines.findIndex((line) => line.includes("..."));
		const first = lines.findIndex((line) => line.includes("Entry 2"));
		expect(leading).toBeGreaterThan(-1);
		expect(first).toBeGreaterThan(leading);

		// A tight budget with the cursor near the top shrinks the window so it ends
		// before the last row, costing a trailing marker on top of the kept rows.
		clackCoreMocks.getRows.mockReturnValue(8);
		const shrunk = render.call({ state: "initial", cursor: 1 });
		expect(shrunk).toContain("Entry 1");
		expect(shrunk.match(/\.\.\./g)?.length).toBe(2);

		// One line tighter: the trailing-marker cost decides the shrink. The two-line
		// header row plus one entry plus both markers exactly fill the budget, so the
		// window must stop after Entry 1 rather than also fitting Entry 2.
		clackCoreMocks.getRows.mockReturnValue(9);
		const exact = render.call({ state: "initial", cursor: 1 });
		expect(exact).toContain("Entry 1");
		expect(exact).not.toContain("Entry 2");
		expect(exact.match(/\.\.\./g)?.length).toBe(2);
	});

	test("it should render an empty submitted label when the cursor points past the list because terminal state can move the cursor beyond the options", async () => {
		clackCoreMocks.state.promptResult = "bare";
		await groupedSelectInput("Pick", { Tools: [{ value: "bare" }] });

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		const output = render.call({ state: "submit", cursor: 99 });

		expect(output).toContain("Pick");
	});

	test("it should render an option value as the row label when the option declares no label because unlabeled values still need a selectable row", async () => {
		clackCoreMocks.state.promptResult = "bare";
		await groupedSelectInput("Pick", { Tools: [{ value: "bare" }] });

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		const output = render.call({ state: "initial", cursor: 1 });

		expect(output).toContain("bare");
	});

	test("it should keep the cursor row visible without a leading marker when it fits the default window because the cursor must never scroll out", async () => {
		clackCoreMocks.state.promptResult = "react";
		await groupedSelectInput("Which?", groupedOptions);

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		const output = render.call({ state: "initial", cursor: 3 });

		expect(output).toContain("Vitest");
		expect(output).toContain("React");
		expect(output).not.toContain("...");
	});

	test("it should mark exactly the cursor row with the active radio because the user must see which option is selected", async () => {
		clackCoreMocks.state.promptResult = "one";
		const twoItemGroup = {
			Group: [
				{ value: "one", label: "One" },
				{ value: "two", label: "Two" },
			],
		};
		await groupedSelectInput("Which?", twoItemGroup);

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		const output = render.call({ state: "initial", cursor: 1 });
		const lines = output.split("\n");

		// Exactly one active radio, on the cursor row; the sibling row is inactive.
		expect(output.split("◉").length - 1).toBe(1);
		expect(lines.find((line) => line.includes("One"))).toContain("◉");
		expect(lines.find((line) => line.includes("Two"))).toContain("○");
		// Group headers carry no radio glyph at all.
		expect(lines.find((line) => line.includes("Group"))?.includes("◉")).toBe(
			false,
		);
	});

	test("it should draw the tree glyphs and continuation prefixes per row position because last items close the guide and wrapped lines indent past it", async () => {
		clackCoreMocks.state.promptResult = "one";
		const twoItemGroup = {
			Group: [
				{ value: "one", label: "Multi\nline one" },
				{ value: "two", label: "Multi\nline two" },
			],
		};
		await groupedSelectInput("Which?", twoItemGroup);

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		const output = render.call({ state: "initial", cursor: 1 });
		const lines = output.split("\n");

		// Non-last item keeps the guide bar (│); the group's final item closes it (└).
		const oneIndex = lines.findIndex(
			(line) => line.includes("Multi") && line.includes("◉"),
		);
		const twoIndex = lines.findIndex(
			(line) => line.includes("Multi") && line.includes("○"),
		);
		expect(oneIndex).toBeGreaterThanOrEqual(0);
		expect(twoIndex).toBeGreaterThanOrEqual(0);
		expect(lines[oneIndex]).toContain("│");
		expect(lines[twoIndex]).toContain("└");

		// Wrapped continuation lines carry the continuation prefix, not a radio:
		// bar-continued (│ + 3 spaces) mid-group, indented 4 spaces after the closing bar.
		const oneContinuation = lines[oneIndex + 1];
		const twoContinuation = lines[twoIndex + 1];
		expect(oneContinuation).toMatch(/│\s{3}line one/u);
		expect(twoContinuation).toMatch(/\s{4}line two/u);
		expect(oneContinuation).not.toMatch(/[◉○]/u);
	});

	test("it should render the submitted row dimmed because the post-selection frame shows the choice, not the list", async () => {
		clackCoreMocks.state.promptResult = "react";
		await groupedSelectInput("Which?", groupedOptions);

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		const output = render.call({ state: "submit", cursor: 1 });

		expect(output).toContain("React");
		expect(output).not.toContain("Vitest");
		expect(output).not.toContain("to navigate");
	});

	test("it should render the canceled row struck through because the frame must show the abandoned choice", async () => {
		clackCoreMocks.state.promptResult = clackMocks.cancelSymbol;
		await expect(
			groupedSelectInput("Which?", groupedOptions),
		).rejects.toBeInstanceOf(OperationCanceledError);

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		const output = render.call({ state: "cancel", cursor: 1 });

		expect(output).toContain("React");
		expect(output).not.toContain("to navigate");
	});

	test("it should reject an empty option map before prompting because a select with nothing to choose cannot proceed", async () => {
		await expect(groupedSelectInput("Which?", {})).rejects.toThrowError(
			'Select prompt "Which?" has no options.',
		);
		expect(clackCoreMocks.state.lastConfig).toBeUndefined();
	});

	test("it should reject a map whose every group is empty because flattening yields no options either", async () => {
		await expect(
			groupedSelectInput("Which?", { Components: [] }),
		).rejects.toThrowError('Select prompt "Which?" has no options.');
	});

	test("it should translate a clack cancel symbol into OperationCanceledError because cancellation is a normal user flow", async () => {
		clackCoreMocks.state.promptResult = clackMocks.cancelSymbol;
		await expect(
			groupedSelectInput("Which?", groupedOptions),
		).rejects.toBeInstanceOf(OperationCanceledError);
	});

	test("it should reject a non-string prompt result because only option values are valid selections", async () => {
		clackCoreMocks.state.promptResult = 42;
		await expect(
			groupedSelectInput("Which?", groupedOptions),
		).rejects.toThrowError(
			'Select prompt "Which?" returned an unexpected value.',
		);
	});

	test("it should reject a string that is not an offered option value because the result must come from the flattened list", async () => {
		clackCoreMocks.state.promptResult = "group-header-value";
		await expect(
			groupedSelectInput("Which?", groupedOptions),
		).rejects.toThrowError(
			'Select prompt "Which?" returned an unexpected value.',
		);
	});

	test("it should resolve with the selected option value because that is the wrapper's contract", async () => {
		clackCoreMocks.state.promptResult = "vitest";
		await expect(groupedSelectInput("Which?", groupedOptions)).resolves.toBe(
			"vitest",
		);
	});

	test("it should shrink the window when even a two-row frame would overflow because the list must fit the terminal", async () => {
		clackCoreMocks.state.promptResult = "e6";
		const manyGroups = {
			Group: [1, 2, 3, 4, 5, 6].map((n) => ({
				value: `e${n}`,
				label: `Entry ${n}`,
			})),
		};
		// availableLines = 9 - 3 (title) - 2 (footer) - 1 = 3: the frame must trim
		// its window (not just window once) until header + rows + marker fit.
		clackCoreMocks.getRows.mockReturnValue(9);
		await groupedSelectInput("Pick", manyGroups);

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		const output = render.call({ state: "initial", cursor: 6 });

		expect(output).toContain("Entry 6");
		expect(output).toContain("Entry 5");
		expect(output).not.toContain("Entry 4");
		// Leading overflow marker only: the window ends at the last row.
		expect(output.match(/\.\.\./g)?.length).toBe(1);
	});

	test("it should pin the window to exactly the rows that fit a small terminal because capacity must clamp to the available line budget", async () => {
		clackCoreMocks.state.promptResult = "three";
		const smallList = {
			Group: [
				{ value: "one", label: "One" },
				{ value: "two", label: "Two" },
				{ value: "three", label: "Three" },
			],
		};
		// availableLines = 10 - 3 (title) - 2 (footer) - 1 = 4. The four-row list
		// spans 5 lines (the two-line header + three items), so the window must
		// shrink to the last three rows; the header is hidden, one leading marker.
		clackCoreMocks.getRows.mockReturnValue(10);
		await groupedSelectInput("Pick", smallList);

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		const output = render.call({ state: "initial", cursor: 3 });
		const lines = output.split("\n");

		expect(lines.find((line) => line.includes("One"))).toContain("○");
		expect(lines.find((line) => line.includes("Two"))).toContain("○");
		expect(lines.find((line) => line.includes("Three"))).toContain("◉");
		expect(output).not.toContain("Group");
		// One leading overflow marker only: the window ends at the last row.
		expect(output.match(/\.\.\./g)?.length).toBe(1);
	});

	test("it should fall back to the option value when an item has no label because headers and submit frames need display text", async () => {
		clackCoreMocks.state.promptResult = "raw";
		const labelLess = { Extras: [{ value: "raw" }] };
		await groupedSelectInput("Which?", labelLess);

		const render = (clackCoreMocks.state.lastConfig as CapturedSelectConfig)
			.render;
		expect(render.call({ state: "initial", cursor: 1 })).toContain("raw");
		expect(render.call({ state: "submit", cursor: 1 })).toContain("raw");
	});
});
