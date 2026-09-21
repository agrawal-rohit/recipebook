import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { run, printError } = vi.hoisted(() => ({
	run: vi.fn(),
	printError: vi.fn(),
}));

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
		await import("../bin/cli.mjs");

		expect(runSettled).toBe(true);
		expect(run).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledWith();
		expect(printError).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	test("it should print the Error message and set exitCode 1 when run rejects with an Error because uncaught CLI failures must surface a string and fail the process", async () => {
		run.mockRejectedValue(new Error("boom"));

		vi.resetModules();
		await import("../bin/cli.mjs");

		expect(printError).toHaveBeenCalledTimes(1);
		expect(printError).toHaveBeenCalledWith("boom");
		expect(process.exitCode).toBe(1);
	});

	test("it should print String(err) and set exitCode 1 when run rejects with a non-Error because thrown values are not always Error instances", async () => {
		run.mockRejectedValue(42);

		vi.resetModules();
		await import("../bin/cli.mjs");

		expect(printError).toHaveBeenCalledTimes(1);
		expect(printError).toHaveBeenCalledWith("42");
		expect(process.exitCode).toBe(1);
	});
});
