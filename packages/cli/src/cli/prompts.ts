import { stripVTControlCharacters, styleText } from "node:util";
import { getRows, SelectPrompt, wrapTextWithPrefix } from "@clack/core";
import {
	confirm,
	isCancel,
	multiselect,
	S_BAR,
	S_BAR_END,
	S_RADIO_ACTIVE,
	S_RADIO_INACTIVE,
	select,
	symbol,
	text,
} from "@clack/prompts";
import chalk from "chalk";
import { OperationCanceledError } from "./errors";
import { dimText, primaryText } from "./labels";

/** One option in a select/multiselect prompt (matches Clack’s unexported `Option<string>`). */
type SelectOption = NonNullable<
	Parameters<typeof select<string>>[0]["options"]
>[number];

/**
 * Throw {@link OperationCanceledError} when Clack reports a cancel symbol.
 * @param value - Prompt result that may be a cancel symbol.
 * @throws {OperationCanceledError} When the user canceled.
 */
function throwIfCanceled<T>(value: T): asserts value is Exclude<T, symbol> {
	if (isCancel(value)) throw new OperationCanceledError();
}

/**
 * Wrap text at the terminal width, applying already-styled prefixes to each line.
 * @param text - Body text to wrap (may contain ANSI styling).
 * @param startPrefix - Styled prefix for the first line.
 * @param continuationPrefix - Styled prefix for every wrapped line after the first.
 * @param reserve - Visible columns the caller prepends outside this text (e.g. a guide bar).
 * @returns Wrapped text with styled prefixes applied, fitting within the terminal width.
 */
function wrapStyledText(
	text: string,
	startPrefix: string,
	continuationPrefix: string,
	reserve = 0,
): string {
	const widest = Math.max(
		stripVTControlCharacters(startPrefix).length,
		stripVTControlCharacters(continuationPrefix).length,
	);
	const pad = " ".repeat(reserve + widest);
	const lines = wrapTextWithPrefix(process.stdout, text, pad, pad, pad).split(
		"\n",
	);
	return lines
		.map((line, index) => {
			const prefix = index === 0 ? startPrefix : continuationPrefix;
			return `${prefix}${trimBreakWhitespace(line.slice(reserve + widest))}`;
		})
		.join("\n");
}

/**
 * Choose which rows to display so the active row stays visible and the frame fits the terminal.
 * @param rows - Rendered rows in display order; a row may span several lines when it wraps.
 * @param cursor - Index of the active row, which is always kept inside the window.
 * @param availableLines - Terminal lines budgeted for the row list, overflow markers included.
 * @returns Rows to render, with `...` markers where rows were hidden.
 */
function windowRows(
	rows: readonly string[],
	cursor: number,
	availableLines: number,
): string[] {
	const linesFor = (start: number, end: number): number => {
		// Each hidden end costs one `...` marker line on top of the rows it replaces.
		let lines = (start > 0 ? 1 : 0) + (end < rows.length ? 1 : 0);
		for (const row of rows.slice(start, end)) lines += row.split("\n").length;
		return lines;
	};

	const offsetFor = (capacity: number): number =>
		cursor >= capacity - 3
			? Math.max(Math.min(cursor - capacity + 3, rows.length - capacity), 0)
			: 0;

	let capacity = Math.min(rows.length, Math.max(availableLines, 1));
	while (capacity > 1) {
		const offset = offsetFor(capacity);
		if (linesFor(offset, offset + capacity) <= availableLines) break;
		capacity -= 1;
	}

	const offset = offsetFor(capacity);
	const visible = rows.slice(offset, offset + capacity);
	if (offset > 0) visible.unshift(styleText("dim", "..."));
	if (offset + capacity < rows.length) visible.push(styleText("dim", "..."));
	return visible;
}

/**
 * Remove the leading whitespace that wrapping leaves when it breaks a line.
 * @param line - A wrapped line body.
 * @returns The line with leading whitespace removed.
 */
function trimBreakWhitespace(line: string): string {
	return line.trimStart();
}

/**
 * Collect option values from a flat select list.
 * @param options - Select options.
 * @returns Distinct option values.
 */
function selectOptionValues(options: readonly SelectOption[]): Set<string> {
	return new Set(options.map((option) => option.value));
}

/**
 * Collect option values from a grouped map.
 * @param options - Options keyed by group label.
 * @returns Distinct option values across every group.
 */
function groupedOptionValues(
	options: Record<string, SelectOption[]>,
): Set<string> {
	return new Set(
		Object.values(options)
			.flat()
			.map((option) => option.value),
	);
}

/**
 * Fail when a select or multiselect has nothing to choose from.
 * @param message - Prompt message, included in the error.
 * @param values - Distinct option values.
 * @throws Error when `values` is empty.
 */
function assertSelectHasOptions(message: string, values: Set<string>): void {
	if (values.size === 0)
		throw new Error(`Select prompt "${message}" has no options.`);
}

/**
 * Fail when a default is not one of the offered option values.
 * @param message - Prompt message, included in the error.
 * @param defaultValue - Default the caller asked to preselect.
 * @param allowed - Offered option values.
 * @throws Error when `defaultValue` is not in `allowed`.
 */
function assertDefaultIsOffered(
	message: string,
	defaultValue: string,
	allowed: Set<string>,
): void {
	if (!allowed.has(defaultValue))
		throw new Error(
			`Select prompt "${message}" has an unexpected default value.`,
		);
}

/**
 * Narrow a select result to an offered option value.
 * @param message - Prompt message, included in the error.
 * @param value - Prompt result after cancel handling.
 * @param allowed - Offered option values.
 * @returns `value` when it is an offered option.
 * @throws Error when `value` is not an offered option.
 */
function offeredSelectValue<Value extends string>(
	message: string,
	value: unknown,
	allowed: Set<string>,
): Value {
	if (typeof value !== "string" || !allowed.has(value))
		throw new Error(`Select prompt "${message}" returned an unexpected value.`);
	return value as Value;
}

/**
 * Narrow a multiselect result to offered option values.
 * @param message - Prompt message, included in the error.
 * @param values - Prompt result after cancel handling.
 * @param allowed - Offered option values.
 * @returns `values` when every entry is an offered option.
 * @throws Error when the result is not an array of offered options.
 */
function offeredMultiselectValues(
	message: string,
	values: unknown,
	allowed: Set<string>,
): string[] {
	if (
		!Array.isArray(values) ||
		values.some((value) => typeof value !== "string" || !allowed.has(value))
	)
		throw new Error(
			`Multiselect prompt "${message}" returned an unexpected value.`,
		);
	return values;
}

/**
 * Prompt for a text input with optional validation and default.
 * @param message - Prompt message to display.
 * @param opts - Optional prompt configuration, including `required`.
 * @param defaultValue - Optional default value.
 * @returns Trimmed user input.
 * @throws {OperationCanceledError} When the user cancels.
 */
export async function textInput(
	message: string,
	opts: { placeholder?: string; required?: boolean } = {},
	defaultValue?: string,
): Promise<string> {
	const raw = await text({
		message,
		...(opts.placeholder !== undefined && { placeholder: opts.placeholder }),
		...(defaultValue !== undefined && {
			initialValue: defaultValue,
			defaultValue,
		}),
		...(opts.required && {
			validate: (value) => (!value?.trim() ? "A value is required" : undefined),
		}),
	});

	throwIfCanceled(raw);
	if (typeof raw !== "string")
		throw new Error(`Text prompt "${message}" returned a non-string value.`);
	return raw.trim();
}

/**
 * Prompt for a single selection from a list of options.
 * @param message - Prompt message to display.
 * @param opts - Select prompt configuration. `options` must be non-empty.
 * @param defaultValue - Optional default selected value; must be one of `options`.
 * @returns Selected value.
 * @throws {OperationCanceledError} When the user cancels.
 * @throws Error when `options` is empty, the default is not offered, or the result is not an offered value.
 */
export async function selectInput<Value extends string>(
	message: string,
	opts: { options: SelectOption[] },
	defaultValue?: Value,
): Promise<Value> {
	const allowed = selectOptionValues(opts.options);
	assertSelectHasOptions(message, allowed);
	if (defaultValue !== undefined)
		assertDefaultIsOffered(message, defaultValue, allowed);

	const value = await select({
		message,
		options: opts.options,
		...(defaultValue !== undefined ? { initialValue: defaultValue } : {}),
	});

	throwIfCanceled(value);
	return offeredSelectValue<Value>(message, value, allowed);
}

/**
 * Prompt for multiple selections.
 * @param message - Prompt message to display.
 * @param opts - Multiselect prompt configuration. `options` must be non-empty.
 * @param defaultValues - Optional default selected values; each must be one of `options`.
 * @returns Selected values.
 * @throws {OperationCanceledError} When the user cancels.
 * @throws Error when `options` is empty, a default is not offered, or a result is not an offered value.
 */
export async function multiselectInput(
	message: string,
	opts: { options: SelectOption[] },
	defaultValues?: string[],
): Promise<string[]> {
	const allowed = selectOptionValues(opts.options);
	assertSelectHasOptions(message, allowed);
	for (const defaultValue of defaultValues ?? [])
		assertDefaultIsOffered(message, defaultValue, allowed);

	const values = await multiselect({
		message,
		options: opts.options,
		...(defaultValues !== undefined ? { initialValues: defaultValues } : {}),
	});

	throwIfCanceled(values);
	return offeredMultiselectValues(message, values, allowed);
}

/**
 * Prompt for one selection arranged under group labels.
 * @param message - Prompt message to display.
 * @param options - Options keyed by group label. At least one option is required.
 * @returns Selected value.
 * @throws {OperationCanceledError} When the user cancels.
 * @throws Error when no options are offered, or the result is not an offered value.
 */
export async function groupedSelectInput(
	message: string,
	options: Record<string, SelectOption[]>,
): Promise<string> {
	const allowed = groupedOptionValues(options);
	assertSelectHasOptions(message, allowed);

	// Flatten groups into the flat row list
	type FlatRow = SelectOption & { group: string | boolean };
	const flatOptions: FlatRow[] = Object.entries(options).flatMap(
		([groupLabel, groupOptions]) => [
			{
				value: groupLabel,
				label: groupLabel,
				group: true as const,
				disabled: true,
			},
			...groupOptions.map((option) => ({
				...option,
				group: groupLabel,
				disabled: false,
			})),
		],
	);

	const guideIndent = 3;
	const renderRow = (option: FlatRow, active: boolean): string => {
		// A non-item row is a group header: a bold blank-line-prefixed label, no radio glyph.
		// Headers always use `value` as the group name (set when flattening).
		if (typeof option.group !== "string")
			return wrapStyledText(
				`\n${chalk.bold(primaryText(String(option.value)))}`,
				"",
				"",
				guideIndent,
			);

		const label = option.label ?? String(option.value);
		const next = flatOptions[flatOptions.indexOf(option) + 1];
		const isLast = next === undefined || next.group === true;
		const prefix = isLast ? `${S_BAR_END} ` : `${S_BAR} `;
		const radio = active ? S_RADIO_ACTIVE : S_RADIO_INACTIVE;
		// The description follows a colon and uses `dimText`, matching `list`'s item lines.
		const hint = option.hint ? dimText(option.hint) : "";
		const text = option.hint ? `${label}: ${hint}` : label;
		const startPrefix = `${styleText("dim", prefix)}${styleText(active ? "green" : "dim", radio)} `;
		const continuationPrefix = isLast
			? "    "
			: `${styleText("dim", S_BAR)}   `;

		return wrapStyledText(text, startPrefix, continuationPrefix, guideIndent);
	};

	// Guide bars are always on (`settings.withGuide` defaults to true), matching the reference.
	const result = await new SelectPrompt<
		SelectOption & { group: string | boolean }
	>({
		options: flatOptions,
		initialValue: flatOptions.find((option) => option.group !== true)?.value,
		render() {
			const state = this.state;
			const title = `${styleText("gray", S_BAR)}\n${symbol(state)}  ${message}\n`;
			const current = flatOptions[this.cursor];
			const rowLabel = current ? (current.label ?? String(current.value)) : "";

			if (state === "submit")
				return `${title}${styleText("gray", S_BAR)}  ${styleText("dim", rowLabel)}`;
			if (state === "cancel")
				return `${title}${styleText("gray", S_BAR)}  ${styleText(["strikethrough", "dim"], rowLabel)}\n${styleText("gray", S_BAR)}`;

			const guidePrefix = `${styleText("cyan", S_BAR)}  `;
			const footerLines = [
				`${styleText("cyan", S_BAR)}  ${styleText("dim", "↑/↓")} to navigate • ${styleText("dim", "Enter:")} confirm`,
				styleText("cyan", S_BAR_END),
			];
			const availableLines =
				getRows(process.stdout) -
				title.split("\n").length -
				footerLines.length -
				1;
			const visible = windowRows(
				flatOptions.map((option, index) =>
					renderRow(option, index === this.cursor),
				),
				this.cursor,
				availableLines,
			);
			const rows = visible.join("\n").replaceAll("\n", `\n${guidePrefix}`);

			return `${title}${guidePrefix}${rows}\n${footerLines.join("\n")}\n`;
		},
	}).prompt();

	throwIfCanceled(result);
	if (typeof result !== "string" || !allowed.has(result))
		throw new Error(`Select prompt "${message}" returned an unexpected value.`);
	return result;
}

/**
 * Prompt for a boolean confirmation.
 * @param message - Prompt message to display.
 * @param opts - Optional confirm prompt configuration.
 * @param defaultValue - Optional default boolean value.
 * @returns User confirmation result.
 * @throws {OperationCanceledError} When the user cancels.
 * @throws Error when the prompt result is not a boolean.
 */
export async function confirmInput(
	message: string,
	opts: { active?: string; inactive?: string } = {},
	defaultValue?: boolean,
): Promise<boolean> {
	const res = await confirm({
		message,
		...opts,
		...(defaultValue !== undefined ? { initialValue: defaultValue } : {}),
	});

	throwIfCanceled(res);
	if (typeof res !== "boolean")
		throw new Error(
			`Confirm prompt "${message}" returned a non-boolean value.`,
		);
	return res;
}
