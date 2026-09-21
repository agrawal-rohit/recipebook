import type { CAC } from "cac";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LoadedRegistry } from "./utils/registry";

const { registerCommandsCli, loadRuntimeRegistry, readConfig } = vi.hoisted(
	() => ({
		registerCommandsCli: vi.fn(),
		loadRuntimeRegistry: vi.fn(),
		readConfig: vi.fn(),
	}),
);

vi.mock("./commands", () => ({ registerCommandsCli }));
vi.mock("./utils/registry", () => ({ loadRuntimeRegistry }));
vi.mock("./cli/config", () => ({ readConfig }));

import run from "./index";

const registerCommandsCliMock = vi.mocked(registerCommandsCli);
const loadRuntimeRegistryMock = vi.mocked(loadRuntimeRegistry);
const readConfigMock = vi.mocked(readConfig);

const fakeRegistry = { registry: {}, indexLocation: "/fake" } as LoadedRegistry;

/**
 * Stub `registerCommandsCli` so `add` awaits the same `loadRegistry` that `run`
 * passes in — enough to exercise registry loading without real command wiring.
 */
function stubRegisterAddCommand(): void {
	registerCommandsCliMock.mockImplementation(
		(app: CAC, loadRegistry: () => Promise<LoadedRegistry>) => {
			app.command("add", "stub add").action(async () => {
				await loadRegistry();
			});
		},
	);
}

function usageLineCount(logSpy: { mock: { calls: unknown[][] } }): number {
	return logSpy.mock.calls
		.map((args) => args.map(String).join(" "))
		.filter((line) => line.includes("Usage:")).length;
}

describe("cli run()", () => {
	let previousArgv: string[];

	beforeEach(() => {
		previousArgv = process.argv;
		registerCommandsCliMock.mockReset();
		loadRuntimeRegistryMock.mockReset();
		readConfigMock.mockReset();
		stubRegisterAddCommand();
		loadRuntimeRegistryMock.mockResolvedValue(fakeRegistry);
		readConfigMock.mockResolvedValue({});
	});

	afterEach(() => {
		process.argv = previousArgv;
		vi.restoreAllMocks();
	});

	test("it should call loadRuntimeRegistry with the trimmed URL and skip readConfig when --registry has surrounding whitespace because the flag is the sole registry source and must be normalized", async () => {
		process.argv = [
			"node",
			"cheetos",
			"add",
			"--registry",
			"  https://example.com/r.json  ",
		];
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		let loadSettled = false;
		loadRuntimeRegistryMock.mockImplementation(async () => {
			await Promise.resolve();
			loadSettled = true;
			return fakeRegistry;
		});

		await expect(run()).resolves.toBeUndefined();

		expect(loadSettled).toBe(true);
		expect(loadRuntimeRegistryMock).toHaveBeenCalledTimes(1);
		expect(loadRuntimeRegistryMock).toHaveBeenCalledWith(
			"https://example.com/r.json",
		);
		expect(readConfigMock).not.toHaveBeenCalled();
		// Matched command must not fall through to the unmatched help branch.
		expect(usageLineCount(logSpy)).toBe(0);
	});

	test("it should read saved config and pass its registry to loadRuntimeRegistry when add runs without --registry because the saved source is the fallback", async () => {
		process.argv = ["node", "cheetos", "add"];
		readConfigMock.mockResolvedValue({
			registry: "https://saved.example.com/r.json",
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(run()).resolves.toBeUndefined();

		expect(readConfigMock).toHaveBeenCalledTimes(1);
		expect(loadRuntimeRegistryMock).toHaveBeenCalledTimes(1);
		expect(loadRuntimeRegistryMock).toHaveBeenCalledWith(
			undefined,
			"https://saved.example.com/r.json",
		);
		expect(readConfigMock.mock.invocationCallOrder[0]).toBeLessThan(
			loadRuntimeRegistryMock.mock.invocationCallOrder[0],
		);
		expect(usageLineCount(logSpy)).toBe(0);
	});

	test.each([
		"   ",
		"",
	])("it should reject with the exact --registry empty-source message when --registry is %j because a blank flag is not a usable source", async (registryFlag) => {
		process.argv = ["node", "cheetos", "add", "--registry", registryFlag];

		await expect(run()).rejects.toEqual(
			new Error("--registry requires a non-empty URL or file path."),
		);
		expect(loadRuntimeRegistryMock).not.toHaveBeenCalled();
		expect(readConfigMock).not.toHaveBeenCalled();
	});

	test("it should print help exactly once when invoked with no command and without --help because bare invocation must show usage without duplicating it", async () => {
		process.argv = ["node", "cheetos"];
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(run()).resolves.toBeUndefined();

		expect(usageLineCount(logSpy)).toBe(1);
		expect(loadRuntimeRegistryMock).not.toHaveBeenCalled();
		expect(readConfigMock).not.toHaveBeenCalled();
	});

	test("it should print help exactly once when --help is passed because CAC already emits help and the unmatched-command branch must not print a second copy", async () => {
		process.argv = ["node", "cheetos", "--help"];
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(run()).resolves.toBeUndefined();

		expect(usageLineCount(logSpy)).toBe(1);
		expect(loadRuntimeRegistryMock).not.toHaveBeenCalled();
		expect(readConfigMock).not.toHaveBeenCalled();
	});
});
