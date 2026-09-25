import { stripVTControlCharacters, styleText } from "node:util";
import { wrapTextWithPrefix } from "@clack/core";
import { isCancel } from "@clack/prompts";
import { OperationCanceledError } from "../errors";

/**
 * Fail fast instead of hanging when a prompt would run without a terminal.
 * @param hint - Remediation specific to this prompt for the error message.
 * @throws Error when stdin is not an interactive terminal.
 */
export function assertInteractiveStdin(hint: string): void {
	if (process.stdin.isTTY) return;
	throw new Error(
		`Cannot prompt for input because stdin is not an interactive terminal. ${hint}`,
	);
}

/**
 * Throw {@link OperationCanceledError} when Clack reports a cancel symbol.
 * @param value - Prompt result that may be a cancel symbol.
 * @throws {OperationCanceledError} When the user canceled.
 */
export function throwIfCanceled<T>(
	value: T,
): asserts value is Exclude<T, symbol> {
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
export function wrapStyledText(
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
export function windowRows(
	rows: readonly string[],
	cursor: number,
	availableLines: number,
): string[] {
	const linesFor = (start: number, end: number): number => {
		// Each hidden end costs one `...` marker line on top of the rows it replaces.
		let lines = 0;
		if (start > 0) lines += 1;
		if (end < rows.length) lines += 1;
		for (const row of rows.slice(start, end)) lines += row.split("\n").length;
		return lines;
	};

	// Keep the cursor a few rows above the window bottom when there is room, but
	// never demand more lookahead than the window can hold (capacity 1 or 2), or
	// the window would scroll the active row out of view.
	const offsetFor = (capacity: number): number => {
		const position = Math.max(capacity - 3, 0);
		return cursor > position
			? Math.max(Math.min(cursor - position, rows.length - capacity), 0)
			: 0;
	};

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
