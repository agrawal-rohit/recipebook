import readline from "node:readline";
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { InterruptError } from "./errors";
import { primaryText } from "./labels";

/** Frame-cycled candy glyph shown beside the title during the intro. */
const LOGO_FRAMES = ["●", "◔", "◕", "◑", "◒", "◓", "◐", "○"] as const;
const LOGO_REST_FRAME = LOGO_FRAMES[0];

/** Options for the animated intro. */
export interface AnimatedIntroOptions {
	/** Intro title shown above the message. Default: `"recipebook"`. */
	title?: string;
	/** Output stream. Default: `process.stdout`. */
	stdout?: NodeJS.WriteStream;
	/** Input stream for Escape / Ctrl+C. Default: `process.stdin`. */
	stdin?: NodeJS.ReadStream;
	/** Animation speed in ms per frame. Default: `150`. */
	frameDelayMs?: number;
}

/**
 * Sleep for the specified number of milliseconds.
 * @param ms - The number of milliseconds to sleep.
 * @returns Promise that resolves after the given delay.
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncate a string to a maximum visible length, respecting ANSI sequences.
 * If truncated, appends "..." to the stripped text.
 * @param s - The input string to truncate.
 * @param max - The maximum visible length.
 * @returns The truncated string (with "..." if truncated).
 */
function truncate(s: string, max: number): string {
	const raw = stripVTControlCharacters(s);
	if (raw.length <= max) return s;
	return `${raw.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * Format the intro title line with an optional animated logo prefix.
 * @param logoFrame - Logo frame to render, or undefined for plain title (non-TTY).
 * @param title - Intro title text.
 * @returns Formatted title line.
 */
function formatTitleLine(logoFrame: string | undefined, title: string): string {
	const titleLabel = chalk.bold(primaryText(title));
	if (!logoFrame) return titleLabel;
	return `${primaryText(logoFrame)} ${titleLabel}`;
}

/**
 * Split a message into words for the typewriter animation.
 * @param message - Intro message text.
 * @returns Word tokens (empty strings from consecutive spaces are kept out).
 */
function splitWords(message: string): string[] {
	return message.split(" ").filter((word) => word.length > 0);
}

/**
 * Usable display width for the intro: at least 40 columns, falling back to 80 when unknown.
 * @param stdout - Output stream.
 * @returns Column count to fit text within.
 */
function visibleColumns(stdout: NodeJS.WriteStream): number {
	return Math.max(40, stdout.columns || 80);
}

/**
 * Print the intro once without animation (CI, piped stdout).
 * @param message - Intro message to display.
 * @param title - Intro title.
 * @param stdout - Output stream.
 */
function printIntroPlain(
	message: string,
	title: string,
	stdout: NodeJS.WriteStream,
): void {
	const columns = visibleColumns(stdout);
	const titleLine = truncate(formatTitleLine(undefined, title), columns);
	const finalMsg = truncate(splitWords(message).join(" "), columns);
	stdout.write(`\n${titleLine}\n${finalMsg}\n`);
}

/** Fixed-height TTY renderer interface. */
export interface FixedHeightRenderer {
	/**
	 * Paint exactly `height` lines (pads with empty strings when short).
	 * @param lines - Lines to display; extras beyond `height` are ignored.
	 */
	paint: (lines: string[]) => void;
	/** Advance the cursor past the reserved block after the animation ends. */
	finish: () => void;
}

/**
 * Create a fixed-height TTY renderer that repaints in place.
 * Pads with empty strings when fewer than `height` lines are provided.
 * @param out - Output stream.
 * @param height - Number of lines reserved for the intro.
 * @returns Paint and finish helpers.
 */
export function createFixedHeightRenderer(
	out: NodeJS.WriteStream,
	height: number,
): FixedHeightRenderer {
	let initialized = false;
	return {
		/**
		 * Paint exactly `height` lines (pads with empty strings when short).
		 * @param lines - Lines to display; extras beyond `height` are ignored.
		 */
		paint(lines: string[]) {
			const padded = Array.from({ length: height }, (_, i) => lines[i] ?? "");

			if (!initialized) {
				for (let i = 0; i < height; i++) {
					if (i) out.write("\n");
					out.write(padded[i]);
				}
				initialized = true;
				return;
			}

			out.write(`\x1b[${height - 1}F`);
			for (let i = 0; i < height; i++) {
				out.write("\x1b[2K");
				out.write(padded[i]);
				if (i < height - 1) out.write("\n");
			}
		},
		/** Advance the cursor past the reserved block after the animation ends. */
		finish() {
			if (initialized) out.write("\n");
			initialized = false;
		},
	};
}

/**
 * Animate a single intro message with a typewriter effect (TTY) or print once (non-TTY).
 * Escape aborts the animation early; Ctrl+C throws {@link InterruptError} after restoring stdin.
 * @param message - Intro message text.
 * @param options - Streams, title, and frame delay.
 * @throws {InterruptError} When the user presses Ctrl+C during a TTY animation.
 */
export async function animatedIntro(
	message: string,
	{
		title = "recipebook",
		stdout = process.stdout,
		stdin = process.stdin,
		frameDelayMs = 150,
	}: AnimatedIntroOptions = {},
): Promise<void> {
	if (!stdout.isTTY) {
		printIntroPlain(message, title, stdout);
		return;
	}

	const words = splitWords(message);
	const columns = visibleColumns(stdout);
	const renderer = createFixedHeightRenderer(stdout, 3);

	let aborted = false;
	let interrupted = false;
	let logoFrameIndex = 0;
	const nextLogoFrame = (): string => {
		const frame = LOGO_FRAMES[logoFrameIndex % LOGO_FRAMES.length];
		logoFrameIndex += 1;
		return frame;
	};

	const rl = readline.createInterface({
		input: stdin,
		escapeCodeTimeout: 50,
	});
	readline.emitKeypressEvents(stdin, rl);
	const hadRawMode = stdin.isTTY;
	if (hadRawMode) stdin.setRawMode(true);

	const onKeypress = (_: string, key: readline.Key) => {
		if (key?.ctrl && key.name === "c") {
			aborted = true;
			interrupted = true;
			return;
		}
		if (key?.name === "escape") {
			aborted = true;
		}
	};
	stdin.on("keypress", onKeypress);

	try {
		const spoken: string[] = [];

		for (const word of ["", ...words]) {
			if (aborted) break;
			if (word) spoken.push(word);

			const msgNow = truncate(spoken.join(" "), columns);
			const titleLine = truncate(
				formatTitleLine(nextLogoFrame(), title),
				columns,
			);
			renderer.paint(["", titleLine, msgNow]);

			await sleep(frameDelayMs);
		}

		if (!aborted) {
			const titleLine = truncate(
				formatTitleLine(LOGO_REST_FRAME, title),
				columns,
			);
			renderer.paint(["", titleLine, truncate(words.join(" "), columns)]);
			await sleep(200);
		}
	} finally {
		if (hadRawMode) stdin.setRawMode(false);
		stdin.off("keypress", onKeypress);
		rl.close();
		renderer.finish();
	}

	if (interrupted) throw new InterruptError();
}
