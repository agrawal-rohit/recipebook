import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OperationCanceledError } from "./errors";
import {
	confirmInput,
	groupedSelectInput,
	multiselectInput,
	selectInput,
	textInput,
} from "./prompts";

const mockText = vi.fn();
const mockSelect = vi.fn();
const mockMultiselect = vi.fn();
const mockConfirm = vi.fn();
const mockIsCancel = vi.fn();

// Emit real ANSI codes so styling can be asserted while ANSI-stripped geometry stays plain.
// Cover the styles `labels.ts` may use: bold headers, brand hex, and the
// muted secondary text via either the `grey`/`gray` aliases (SGR 90) or a non-brand hex.
vi.mock("chalk", () => {
	const sgr =
		(code: number) =>
		(text: string): string =>
			`\u001b[${code}m${text}\u001b[39m`;
	const muted = sgr(90);
	return {
		default: {
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
			hex: (color: string) => sgr(color === "#F59E0B" ? 91 : 37),
			grey: muted,
			gray: muted,
		},
	};
});

// Keep the real clack helpers (limitOptions, glyph constants, symbol) so render() output can be
// asserted; only the prompt entry points are replaced.
vi.mock("@clack/prompts", async (importOriginal) => ({
	...((await importOriginal()) as object),
	text: (...args: unknown[]) => mockText(...args),
	select: (...args: unknown[]) => mockSelect(...args),
	multiselect: (...args: unknown[]) => mockMultiselect(...args),
	confirm: (...args: unknown[]) => mockConfirm(...args),
	isCancel: (...args: unknown[]) => mockIsCancel(...args),
}));

// `groupedSelectInput` renders with core's SelectPrompt; fake the class so tests can
// resolve a chosen value without a TTY while still asserting the flattened option rows.
const mockCoreSelectPrompt = vi.fn();
const mockCoreSelectOptions = vi.fn();
vi.mock("@clack/core", async (importOriginal) => ({
	...((await importOriginal()) as object),
	SelectPrompt: class {
		constructor(opts: unknown) {
			mockCoreSelectOptions(opts);
		}
		prompt(): Promise<unknown> {
			return mockCoreSelectPrompt();
		}
	},
}));

// Value the faked core SelectPrompt resolves with; set per test via `resolveGroupedSelectWith`.
function resolveGroupedSelectWith(value: unknown): void {
	mockCoreSelectPrompt.mockResolvedValue(value);
}

/** Renderer captured from the last groupedSelectInput call, with its flattened option rows. */
function captureGroupedRender(): {
	render: (this: { state: string; cursor: number }) => string;
	options: Array<{
		value: string;
		group: string | boolean;
		disabled?: boolean;
	}>;
} {
	const payload = mockCoreSelectOptions.mock.calls.at(-1)?.[0] as {
		render: (this: { state: string; cursor: number }) => string;
		options: Array<{
			value: string;
			group: string | boolean;
			disabled?: boolean;
		}>;
	};
	return payload;
}

/** Matches ANSI SGR escape sequences so rendered frames can be compared as plain text. */
const ANSI_SGR = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`,
	"g",
);

/** Render one row list frame at a given cursor position, ANSI stripped. */
function renderFrame(cursor: number, state = "active"): string[] {
	const { render } = captureGroupedRender();
	return render.call({ state, cursor }).replace(ANSI_SGR, "").split("\n");
}

/** Render one row list frame at a given cursor position, keeping ANSI codes. */
function renderFrameStyled(cursor: number): string[] {
	const { render } = captureGroupedRender();
	return render.call({ state: "active", cursor }).split("\n");
}

describe("cli/prompts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsCancel.mockReturnValue(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("textInput", () => {
		test("should call text with message", async () => {
			mockText.mockResolvedValue("test response");

			await textInput("Enter your name");

			const payload = mockText.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(payload).toEqual({ message: "Enter your name" });
			expect("placeholder" in payload).toBe(false);
			expect("initialValue" in payload).toBe(false);
			expect("defaultValue" in payload).toBe(false);
		});

		test("should return trimmed value", async () => {
			mockText.mockResolvedValue("  test value  ");

			await expect(textInput("Enter text")).resolves.toBe("test value");
		});

		test("should pass default value as initialValue and defaultValue", async () => {
			mockText.mockResolvedValue("default-name");

			await textInput("Enter name", {}, "default-name");

			expect(mockText).toHaveBeenCalledWith({
				message: "Enter name",
				initialValue: "default-name",
				defaultValue: "default-name",
			});
		});

		test("should pass placeholder option", async () => {
			mockText.mockResolvedValue("test");

			await textInput("Enter text", { placeholder: "Enter here" });

			expect(mockText).toHaveBeenCalledWith({
				message: "Enter text",
				placeholder: "Enter here",
			});
		});

		test("should pass a required validate function", async () => {
			mockText.mockResolvedValue("ok");

			await textInput("Enter name", { required: true });

			const call = mockText.mock.calls[0]?.[0] as {
				validate?: (value: string | undefined) => string | undefined;
			};
			expect(call.validate?.("")).toBe("A value is required");
			expect(call.validate?.("   ")).toBe("A value is required");
			expect(call.validate?.("ok")).toBeUndefined();
		});

		test("should throw OperationCanceledError when canceled", async () => {
			const cancelSymbol = Symbol("clack:cancel");
			mockText.mockResolvedValue(cancelSymbol);
			mockIsCancel.mockReturnValue(true);

			await expect(textInput("Enter text")).rejects.toBeInstanceOf(
				OperationCanceledError,
			);
		});

		test("should throw when the result is not a string", async () => {
			mockText.mockResolvedValue(42);

			await expect(textInput("Enter text")).rejects.toThrow(
				'Text prompt "Enter text" returned a non-string value.',
			);
		});
	});

	describe("selectInput", () => {
		const options = [
			{ label: "Option 1", value: "option1" },
			{ label: "Option 2", value: "option2" },
		];

		test("should call select with message and options", async () => {
			mockSelect.mockResolvedValue("option1");

			await selectInput("Select an option", { options });

			const payload = mockSelect.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(payload).toEqual({
				message: "Select an option",
				options,
			});
			expect("initialValue" in payload).toBe(false);
		});

		test("should return selected value", async () => {
			mockSelect.mockResolvedValue("opt1");

			await expect(
				selectInput("Select", {
					options: [
						{ label: "opt1", value: "opt1" },
						{ label: "opt2", value: "opt2" },
					],
				}),
			).resolves.toBe("opt1");
		});

		test("should pass default value as initialValue", async () => {
			mockSelect.mockResolvedValue("option1");

			await selectInput("Select", { options }, "option1");

			expect(mockSelect).toHaveBeenCalledWith({
				message: "Select",
				options,
				initialValue: "option1",
			});
		});

		test("should throw OperationCanceledError when canceled", async () => {
			mockSelect.mockResolvedValue(Symbol("clack:cancel"));
			mockIsCancel.mockReturnValue(true);

			await expect(selectInput("Select", { options })).rejects.toBeInstanceOf(
				OperationCanceledError,
			);
		});

		test("should throw when options are empty", async () => {
			await expect(
				selectInput("Select an option", { options: [] }),
			).rejects.toThrow('Select prompt "Select an option" has no options.');
			expect(mockSelect).not.toHaveBeenCalled();
		});

		test("should throw when the default is not an offered option", async () => {
			await expect(
				selectInput("Select", { options }, "missing"),
			).rejects.toThrow(
				'Select prompt "Select" has an unexpected default value.',
			);
			expect(mockSelect).not.toHaveBeenCalled();
		});

		test("should throw when the selected value is not an offered option", async () => {
			mockSelect.mockResolvedValue("missing");

			await expect(selectInput("Select", { options })).rejects.toThrow(
				'Select prompt "Select" returned an unexpected value.',
			);
		});
	});

	describe("multiselectInput", () => {
		const options = [
			{ label: "Option 1", value: "option1" },
			{ label: "Option 2", value: "option2" },
		];

		test("should call multiselect with message and options", async () => {
			mockMultiselect.mockResolvedValue(["option1", "option2"]);

			await multiselectInput("Select multiple options", { options });

			const payload = mockMultiselect.mock.calls[0]?.[0] as Record<
				string,
				unknown
			>;
			expect(payload).toEqual({
				message: "Select multiple options",
				options,
			});
			expect("initialValues" in payload).toBe(false);
		});

		test("should return array of selected values", async () => {
			const selectedValues = ["option1", "option2"];
			mockMultiselect.mockResolvedValue(selectedValues);

			await expect(
				multiselectInput("Select multiple", { options }),
			).resolves.toEqual(selectedValues);
		});

		test("should pass default values as initialValues", async () => {
			mockMultiselect.mockResolvedValue(["option1"]);

			const defaultValues = ["option1"];
			await multiselectInput("Select", { options }, defaultValues);

			expect(mockMultiselect).toHaveBeenCalledWith({
				message: "Select",
				options,
				initialValues: defaultValues,
			});
		});

		test("should throw OperationCanceledError when canceled", async () => {
			mockMultiselect.mockResolvedValue(Symbol("clack:cancel"));
			mockIsCancel.mockReturnValue(true);

			await expect(
				multiselectInput("Select multiple", { options }),
			).rejects.toBeInstanceOf(OperationCanceledError);
		});

		test("should throw when options are empty", async () => {
			await expect(
				multiselectInput("Select multiple options", { options: [] }),
			).rejects.toThrow(
				'Select prompt "Select multiple options" has no options.',
			);
			expect(mockMultiselect).not.toHaveBeenCalled();
		});

		test("should throw when a default is not an offered option", async () => {
			await expect(
				multiselectInput("Select", { options }, ["missing"]),
			).rejects.toThrow(
				'Select prompt "Select" has an unexpected default value.',
			);
			expect(mockMultiselect).not.toHaveBeenCalled();
		});

		test("should throw when a selected value is not an offered option", async () => {
			mockMultiselect.mockResolvedValue(["option1", "missing"]);

			await expect(
				multiselectInput("Select multiple", { options }),
			).rejects.toThrow(
				'Multiselect prompt "Select multiple" returned an unexpected value.',
			);
		});
	});

	describe("groupedSelectInput", () => {
		const options = {
			Configurations: [
				{
					label: "Pull Request Template",
					value: "pr-template-configuration",
					hint: "PR template",
				},
			],
			Workflows: [{ label: "Code Quality", value: "code-quality-workflow" }],
		};

		test("builds grouped rows with header rows around items and defaults to the first item", async () => {
			resolveGroupedSelectWith("pr-template-configuration");

			const result = await groupedSelectInput(
				"Which registry item should be added?",
				options,
			);

			const payload = mockCoreSelectOptions.mock.calls[0]?.[0] as {
				options: Array<{ value: string; label?: string; group: unknown }>;
				initialValue: string;
			};
			expect(payload.options).toEqual([
				{
					value: "Configurations",
					label: "Configurations",
					group: true,
					disabled: true,
				},
				{
					label: "Pull Request Template",
					value: "pr-template-configuration",
					hint: "PR template",
					group: "Configurations",
					disabled: false,
				},
				{
					value: "Workflows",
					label: "Workflows",
					group: true,
					disabled: true,
				},
				{
					label: "Code Quality",
					value: "code-quality-workflow",
					group: "Workflows",
					disabled: false,
				},
			]);
			// Initial value is the first item, never a group header.
			expect(payload.initialValue).toBe("pr-template-configuration");
			expect(result).toBe("pr-template-configuration");
		});

		test("renders the grouped tree exactly like clack's groupMultiselect, with radio glyphs", async () => {
			resolveGroupedSelectWith("pr-template-configuration");
			await groupedSelectInput("Which registry item should be added?", {
				Configurations: [
					{
						label: "Pull Request Template",
						value: "pr-template-configuration",
						hint: "PR template",
					},
					{ label: "Code of Conduct", value: "code-of-conduct" },
				],
				Workflows: [{ label: "Code Quality", value: "code-quality-workflow" }],
			});

			// Every item row carries its description, so the list scans without moving. Each
			// group header is preceded by a blank row that spaces the groups apart.
			const activeLines = renderFrame(1);
			expect(activeLines[0]).toBe("│");
			expect(activeLines[1]).toBe("◆  Which registry item should be added?");
			expect(activeLines[2]).toBe("│  ");
			// Headers are glyph-less labels whose text aligns with the items' tree bars.
			expect(activeLines[3]).toBe("│  Configurations");
			expect(activeLines[4]).toBe("│  │ ● Pull Request Template: PR template");
			expect(activeLines[5]).toBe("│  └ ○ Code of Conduct");
			expect(activeLines[6]).toBe("│  ");
			expect(activeLines[7]).toBe("│  Workflows");
			expect(activeLines[8]).toBe("│  └ ○ Code Quality");
			// Reference footer: instruction line keeps the guide bar, then a lone └.
			expect(activeLines[9]).toBe("│  ↑/↓ to navigate • Enter: confirm");
			expect(activeLines[10]).toBe("└");

			// Moving the cursor dims the previously active row but keeps its description.
			const movedLines = renderFrame(2);
			expect(movedLines[4]).toBe("│  │ ○ Pull Request Template: PR template");
			expect(movedLines[5]).toBe("│  └ ● Code of Conduct");
		});

		test("shows a description on every item row, not just the active one", async () => {
			resolveGroupedSelectWith("pr-template-configuration");
			await groupedSelectInput("Which registry item should be added?", {
				Configurations: [
					{
						label: "Pull Request Template",
						value: "pr-template-configuration",
						hint: "Standard PR template.",
					},
					{
						label: "Code of Conduct",
						value: "code-of-conduct",
						hint: "Contributor Covenant.",
					},
				],
			});

			// Cursor sits on the first item, so the second row is inactive yet still describes.
			// Line 2 is the blank row spacing the group header at line 3.
			const lines = renderFrame(1);
			expect(lines[4]).toBe(
				"│  │ ● Pull Request Template: Standard PR template.",
			);
			expect(lines[5]).toBe("│  └ ○ Code of Conduct: Contributor Covenant.");
		});

		test("styles group headers distinctly from item rows", async () => {
			resolveGroupedSelectWith("pr-template-configuration");
			await groupedSelectInput("Which registry item should be added?", {
				Configurations: [
					{
						label: "Pull Request Template",
						value: "pr-template-configuration",
						hint: "PR template",
					},
				],
			});

			const styled = renderFrameStyled(1);
			// Row 2 is the blank row spacing the group, so the header sits at row 3.
			const headerRow = styled[3] as string;
			const itemRow = styled[4] as string;

			// Header is bold (SGR 1) and brand-coloured.
			expect(headerRow).toContain("\u001b[1m");
			expect(headerRow).toContain("\u001b[91m");
			// Item rows are muted rather than bold, keeping headers visually dominant.
			expect(itemRow).not.toContain("\u001b[1m");
			expect(itemRow).not.toContain("\u001b[91m");
			// Description uses the muted style (`dimText`) introduced by a colon, as in `list`.
			// Accept either SGR 90 (grey/gray alias) or 37 (explicit muted hex).
			const mutedSgr = new RegExp(`${String.fromCharCode(27)}\\[(90|37)m`);
			expect(itemRow).toMatch(mutedSgr);
			expect(itemRow).toMatch(
				new RegExp(`Template: ${mutedSgr.source}PR template`),
			);
			expect(itemRow).not.toContain("(");
			// Header is a plain label: no radio glyph either active or inactive.
			const stripped = headerRow.replace(ANSI_SGR, "");
			expect(stripped).toBe("│  Configurations");
			expect(stripped).not.toContain("○");
			expect(stripped).not.toContain("●");
		});

		test("wraps long hints inside the terminal and keeps the tree spine intact", async () => {
			resolveGroupedSelectWith("release-package");
			// Fix the width so the assertion is deterministic regardless of the test terminal.
			Object.defineProperty(process.stdout, "columns", {
				value: 60,
				configurable: true,
			});
			await groupedSelectInput("Which registry item should be added?", {
				Workflows: [
					{
						label: "Release Package",
						value: "release-package",
						hint: "Release Please automation that opens a Release PR on pushes to main and handles package publication.",
					},
					{ label: "Repo Settings", value: "repo-settings" },
				],
			});

			const lines = renderFrame(1);
			const hintStart = lines.findIndex((line) =>
				line.includes("Release Package"),
			);
			const hintLines = lines.slice(hintStart, hintStart + 3);

			// Regression guard: before the fix the hint wrapped at ~46 visible columns (ANSI
			// escapes in the prefix were counted as visible) and continuations lost the guide
			// bar, so text jutted left of the tree spine.
			expect(hintLines.length).toBe(3);
			for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);

			// Every line of the group stays inside the left guide bar, and item lines keep the
			// tree bar (or the last item's `└`) at the same column as their label row.
			for (const line of hintLines) expect(line.startsWith("│  │")).toBe(true);
			expect(hintLines[0]).toContain("● Release Package:");
			// The group header keeps its own row on the guide bar, separated from the items
			// by one blank row that spaces the groups apart.
			expect(lines[hintStart - 1]).toBe("│  Workflows");
			expect(lines[hintStart - 2]).toBe("│  ");
			expect(lines[hintStart + 3]).toBe("│  └ ○ Repo Settings");
		});

		test("windows rows to the terminal height and follows the cursor", async () => {
			resolveGroupedSelectWith("item-19");
			// A short terminal forces the row list to window; 3 title/footer lines + 1 blank.
			Object.defineProperty(process.stdout, "columns", {
				value: 100,
				configurable: true,
			});
			Object.defineProperty(process.stdout, "rows", {
				value: 12,
				configurable: true,
			});

			const many = Array.from({ length: 20 }, (_, index) => ({
				label: `Item ${index}`,
				value: `item-${index}`,
			}));
			await groupedSelectInput("Pick one", { Group: many });

			// Regression guard: before windowing, the frame grew to the full list height. It
			// overflowed the terminal, which broke clack's line-diff renderer and left stale
			// rows on screen (the duplicated "Pull Request Template") with no auto-scroll.
			const needsCursorRow = (cursor: number): string[] => renderFrame(cursor);
			for (const cursor of [1, 5, 10, 20]) {
				const lines = needsCursorRow(cursor);
				expect(lines.length).toBeLessThanOrEqual(12);
				// The active row is always inside the window, so its glyph is visible.
				expect(lines.some((line) => line.includes("●"))).toBe(true);
			}

			// Later rows scroll into view as the cursor advances down the list.
			expect(needsCursorRow(1).some((line) => line.includes("Item 0"))).toBe(
				true,
			);
			expect(needsCursorRow(20).some((line) => line.includes("Item 19"))).toBe(
				true,
			);
			// Overflowed ends are marked rather than silently truncated.
			expect(needsCursorRow(20).some((line) => line.includes("..."))).toBe(
				true,
			);
		});

		test("falls back to the option value when label is omitted", async () => {
			resolveGroupedSelectWith("bare-value");
			await groupedSelectInput("Pick one", {
				Group: [{ value: "bare-value" }],
			});

			// Item rows and settled frames use the value when no label was provided.
			const active = renderFrame(1);
			expect(active.some((line) => line.includes("● bare-value"))).toBe(true);

			const submitted = renderFrame(1, "submit");
			expect(submitted.some((line) => line.includes("bare-value"))).toBe(true);
		});

		test("renders settled submit and cancel frames", async () => {
			resolveGroupedSelectWith("pr-template-configuration");
			await groupedSelectInput("Which registry item should be added?", options);

			const submitted = renderFrame(1, "submit");
			expect(submitted[1]).toMatch(/◇|◆/);
			expect(
				submitted.some((line) => line.includes("Pull Request Template")),
			).toBe(true);
			// Submit collapses to title + settled label; no navigation footer.
			expect(submitted.some((line) => line.includes("↑/↓"))).toBe(false);

			const canceled = renderFrame(1, "cancel");
			expect(
				canceled.some((line) => line.includes("Pull Request Template")),
			).toBe(true);
			expect(canceled.some((line) => line.includes("↑/↓"))).toBe(false);
		});

		test("renders an empty settled label when the cursor is out of range", async () => {
			resolveGroupedSelectWith("pr-template-configuration");
			await groupedSelectInput("Which registry item should be added?", options);

			const { options: rows } = captureGroupedRender();
			const submitted = renderFrame(rows.length + 5, "submit");
			// Title + blank settled row only; no option label to print.
			expect(
				submitted.some((line) => line.includes("Pull Request Template")),
			).toBe(false);
			expect(submitted.some((line) => line.includes("Configurations"))).toBe(
				false,
			);
		});

		test("marks group headers disabled so they cannot be selected", async () => {
			resolveGroupedSelectWith("code-quality-workflow");

			await groupedSelectInput("Pick one", options);

			const payload = mockCoreSelectOptions.mock.calls[0]?.[0] as {
				options: Array<{ group: unknown; disabled?: boolean }>;
			};
			const headers = payload.options.filter((option) => option.group === true);
			const items = payload.options.filter((option) => option.group !== true);
			expect(headers.length).toBeGreaterThan(0);
			expect(headers.every((option) => option.disabled === true)).toBe(true);
			expect(items.every((option) => option.disabled === false)).toBe(true);
		});

		test("should throw OperationCanceledError when canceled", async () => {
			resolveGroupedSelectWith(Symbol("clack:cancel"));
			mockIsCancel.mockReturnValue(true);

			await expect(
				groupedSelectInput("Which registry item should be added?", options),
			).rejects.toBeInstanceOf(OperationCanceledError);
		});

		test("should throw when no grouped options are offered", async () => {
			await expect(
				groupedSelectInput("Which registry item should be added?", {}),
			).rejects.toThrow(
				'Select prompt "Which registry item should be added?" has no options.',
			);
			expect(mockCoreSelectOptions).not.toHaveBeenCalled();
		});

		test("should throw when the selected value is not an offered option", async () => {
			resolveGroupedSelectWith("missing");

			await expect(
				groupedSelectInput("Which registry item should be added?", options),
			).rejects.toThrow(
				'Select prompt "Which registry item should be added?" returned an unexpected value.',
			);
		});
	});

	describe("confirmInput", () => {
		test("should call confirm with message", async () => {
			mockConfirm.mockResolvedValue(true);

			await confirmInput("Do you want to continue?");

			const payload = mockConfirm.mock.calls[0]?.[0] as Record<string, unknown>;
			expect(payload).toEqual({
				message: "Do you want to continue?",
			});
			expect("initialValue" in payload).toBe(false);
		});

		test("should return boolean value for true", async () => {
			mockConfirm.mockResolvedValue(true);

			await expect(confirmInput("Confirm?")).resolves.toBe(true);
		});

		test("should return boolean value for false", async () => {
			mockConfirm.mockResolvedValue(false);

			await expect(confirmInput("Confirm?")).resolves.toBe(false);
		});

		test("should pass default value as initialValue", async () => {
			mockConfirm.mockResolvedValue(true);

			await confirmInput("Confirm?", {}, true);

			expect(mockConfirm).toHaveBeenCalledWith({
				message: "Confirm?",
				initialValue: true,
			});
		});

		test("should throw OperationCanceledError when canceled", async () => {
			mockConfirm.mockResolvedValue(Symbol("clack:cancel"));
			mockIsCancel.mockReturnValue(true);

			await expect(confirmInput("Confirm?")).rejects.toBeInstanceOf(
				OperationCanceledError,
			);
		});

		test("should throw when the result is not a boolean", async () => {
			mockConfirm.mockResolvedValue("yes");

			await expect(confirmInput("Confirm?")).rejects.toThrow(
				'Confirm prompt "Confirm?" returned a non-boolean value.',
			);
		});
	});
});
