import { dangerHighlight, dimText } from "./labels";

/** User canceled an interactive prompt (Ctrl+C / Escape in Clack). */
export class OperationCanceledError extends Error {
	readonly exitCode = 0;
	constructor(message = "Operation canceled") {
		super(message);
		this.name = "OperationCanceledError";
	}
}

/** User interrupted the CLI (Ctrl+C during the animated intro). */
export class InterruptError extends Error {
	readonly exitCode = 130;
	constructor(message = "Interrupted") {
		super(message);
		this.name = "InterruptError";
	}
}

/**
 * Print a message with a colored background label prefix.
 * @param label - Styled label (e.g. `" error "` from {@link dangerHighlight}).
 * @param message - Message to display.
 */
function printLabeled(label: string, message: string): void {
	console.log();
	console.error(`${label} ${message}`);
	console.log();
}

/**
 * Print an error message with a red background prefix.
 * @param message - The error message to display.
 */
export function printError(message: string): void {
	printLabeled(dangerHighlight(" error "), message);
}

/**
 * Print a cancel message (non-fatal styling).
 * @param message - The cancel message to display.
 */
export function printCancel(message: string): void {
	printLabeled(dimText(" canceled "), message);
}

/**
 * Run a CLI command action and map known failures to process exits.
 * CAC does not reliably surface async action rejections to the bin entrypoint,
 * so command actions should wrap their body with this helper.
 * @param action - Async command body.
 */
export async function runCliCommand(
	action: () => Promise<void>,
): Promise<void> {
	try {
		await action();
	} catch (error) {
		if (error instanceof OperationCanceledError) {
			printCancel(error.message);
			process.exit(error.exitCode);
		}

		if (error instanceof InterruptError) {
			process.exit(error.exitCode);
		}

		const message = error instanceof Error ? error.message : String(error);
		printError(message);
		process.exit(1);
	}
}
