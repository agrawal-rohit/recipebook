import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as sourceEntry from "./index";

const { run, printError } = vi.hoisted(() => ({
	run: vi.fn(),
	printError: vi.fn(),
}));

/** Non-literal so tsc does not require typings for the published .mjs bin glue. */
const CLI_MJS_ENTRY = "../bin/cli.mjs";

vi.mock("../dist/index.js", () => ({
	default: {
		default: run,
		printError,
	},
}));

describe("cli.mjs published bin glue", () => {
	let previousExitCode: typeof process.exitCode;

	beforeEach(() => {
		previousExitCode = process.exitCode;
		process.exitCode = undefined;
		run.mockReset();
		printError.mockReset();
	});

	afterEach(() => {
		process.exitCode = previousExitCode;
	});

	test("it should await a successful run without printing or failing when run resolves because a clean CLI exit must leave exitCode unset and errors unprinted", async () => {
		let runSettled = false;
		run.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					queueMicrotask(() => {
						runSettled = true;
						resolve();
					});
				}),
		);

		vi.resetModules();
		await import(CLI_MJS_ENTRY);

		expect(runSettled).toBe(true);
		expect(run).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledWith();
		expect(printError).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	test("it should print the Error message and set exitCode 1 when run rejects with an Error because uncaught CLI failures must surface a string and fail the process", async () => {
		run.mockRejectedValue(new Error("boom"));

		vi.resetModules();
		await import(CLI_MJS_ENTRY);

		expect(printError).toHaveBeenCalledTimes(1);
		expect(printError).toHaveBeenCalledWith("boom");
		expect(process.exitCode).toBe(1);
	});

	test("it should print String(err) and set exitCode 1 when run rejects with a non-Error because thrown values are not always Error instances", async () => {
		run.mockRejectedValue(42);

		vi.resetModules();
		await import(CLI_MJS_ENTRY);

		expect(printError).toHaveBeenCalledTimes(1);
		expect(printError).toHaveBeenCalledWith("42");
		expect(process.exitCode).toBe(1);
	});
});

describe("src entry exports match what bin/cli.mjs consumes", () => {
	test("it should expose a callable default run and a named printError from the real TypeScript entry because bin/cli.mjs destructures exactly those two exports from the compiled artifact", () => {
		// The file-level `vi.mock("../dist/index.js")` above does not touch this
		// specifier, so this static import is the real entry — the same module
		// tsc compiles into the dist file the published bin imports.
		const entry = sourceEntry as Record<string, unknown>;

		expect(typeof entry.default).toBe("function");
		expect(typeof entry.printError).toBe("function");
	});

	test("it should keep the CommonJS module target in tsconfig.base.json because bin/cli.mjs's `import indexModule from '../dist/index.js'` only yields indexModule.default/.printError under CJS interop", () => {
		const baseConfig = JSON.parse(
			readFileSync(path.join(__dirname, "../../../tsconfig.base.json"), "utf8"),
		) as { compilerOptions?: { module?: string } };

		expect(baseConfig.compilerOptions?.module).toBe("CommonJS");
	});
});
