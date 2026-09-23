import { beforeEach, describe, expect, test, vi } from "vitest";
import { OperationCanceledError } from "./errors";
import {
	confirmInput,
	multiselectInput,
	selectInput,
	textInput,
} from "./prompts";

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

describe("cancel translation (P1)", () => {
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

describe("select value validation (P2/P3)", () => {
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

describe("text handling (P4)", () => {
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
