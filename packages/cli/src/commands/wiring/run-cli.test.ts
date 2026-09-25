import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type MockInstance,
	test,
	vi,
} from "vitest";
import { runCliCommand } from "../../cli/errors";

describe("runCliCommand non-Error fallback", () => {
	let errorOutput: string[];
	let exitSpy: MockInstance<typeof process.exit>;

	beforeEach(() => {
		errorOutput = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errorOutput.push(args.map((arg) => String(arg)).join(" "));
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		// Record the requested exit without terminating the test process.
		exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined as never) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("it should surface a non-Error throw value as its string form and exit 1 because only Error instances carry a message yet the CLI must still fail loudly", async () => {
		await runCliCommand(async () => {
			throw "boom";
		});

		// printError receives the string form of the thrown value.
		expect(errorOutput.join("\n")).toContain("boom");
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(exitSpy).toHaveBeenCalledTimes(1);
	});
});
