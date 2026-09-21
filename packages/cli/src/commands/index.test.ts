import type { Registry } from "@cheetos/core";
import cac from "cac";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OperationCanceledError } from "../cli/errors";
import type { LoadedRegistry } from "../utils/registry";
import { addCommand } from "./add";
import {
	configGetCommand,
	configSetCommand,
	configUnsetCommand,
} from "./config";
import { registerCommandsCli } from "./index";

vi.mock("./add", () => ({ addCommand: vi.fn(async () => {}) }));
vi.mock("./config", () => ({
	configGetCommand: vi.fn(async () => {}),
	configSetCommand: vi.fn(async () => "/fake/config.json"),
	configUnsetCommand: vi.fn(async () => false),
}));
vi.mock("../cli/animated-intro", () => ({
	animatedIntro: vi.fn(async () => {}),
}));

const addMock = vi.mocked(addCommand);
const configGetMock = vi.mocked(configGetCommand);
const configSetMock = vi.mocked(configSetCommand);
const configUnsetMock = vi.mocked(configUnsetCommand);

/**
 * Build the public shape of the post-refactor `NoRegistrySourceError` without
 * importing the not-yet-existing class: the contract fixes only its `name`.
 */
function noRegistrySourceError(): Error {
	return Object.assign(
		new Error(
			"No registry source configured. Add one with `cheetos configure set <https URL or file path>`, set CHEETOS_REGISTRY, or pass --registry <source>.",
		),
		{ name: "NoRegistrySourceError" },
	);
}

/**
 * Stub `process.stdin.isTTY`. Callers restore via `restoreIsTTY`.
 */
function stubIsTTY(value: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", {
		value,
		configurable: true,
	});
}

/**
 * Restore `process.stdin.isTTY` to its original state after a test.
 */
function restoreIsTTY(): void {
	delete (process.stdin as { isTTY?: boolean }).isTTY;
}

/**
 * Build a CAC app wired exactly like `run()` and parse a configure invocation.
 * CAC never awaits the registered action, so callers must wait for the
 * observable effect (dispatch or `process.exit`) afterwards.
 */
async function runConfigureCli(args: string[]): Promise<void> {
	const app = cac("cheetos");
	registerCommandsCli(app, async () => {
		throw new Error("registry loader must not run for configure commands");
	});
	await app.parse(["node", "cheetos", ...args]);
}

/**
 * Build a CAC app wired exactly like `run()` and parse an `add` invocation
 * with the given registry loader.
 */
async function runAddCli(
	loadRegistry: () => Promise<LoadedRegistry>,
): Promise<void> {
	const app = cac("cheetos");
	registerCommandsCli(app, loadRegistry);
	await app.parse(["node", "cheetos", "add"]);
}

describe("configure command wiring", () => {
	let errorOutput: string[];
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		addMock.mockClear();
		configGetMock.mockClear();
		configSetMock.mockClear();
		configUnsetMock.mockClear();
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

	test("it should dispatch `configure get` to configGetCommand with no arguments when parsing that invocation because the get action takes no source", async () => {
		await runConfigureCli(["configure", "get"]);
		await vi.waitFor(() => expect(configGetMock).toHaveBeenCalledTimes(1));
		expect(configGetMock).toHaveBeenCalledWith();
	});

	test("it should pass an explicit source to configSetCommand when one is present because the flag supplies the source directly", async () => {
		await runConfigureCli(["configure", "set", "https://example.com/r.json"]);
		await vi.waitFor(() => expect(configSetMock).toHaveBeenCalledTimes(1));
		expect(configSetMock).toHaveBeenCalledWith("https://example.com/r.json");
	});

	test("it should pass undefined to configSetCommand so it prompts itself when no source is given because the source must then come interactively", async () => {
		await runConfigureCli(["configure", "set"]);
		await vi.waitFor(() => expect(configSetMock).toHaveBeenCalledTimes(1));
		expect(configSetMock).toHaveBeenCalledWith(undefined);
	});

	test("it should dispatch `configure unset` to configUnsetCommand when parsing that invocation because the unset action clears the registry", async () => {
		await runConfigureCli(["configure", "unset"]);
		await vi.waitFor(() => expect(configUnsetMock).toHaveBeenCalledTimes(1));
		expect(configUnsetMock).toHaveBeenCalledWith();
	});

	test("it should print an error and exit 1 without dispatching when `configure get` is given a source because the get action does not take a source", async () => {
		await runConfigureCli(["configure", "get", "https://example.com/r.json"]);
		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(configGetMock).not.toHaveBeenCalled();
		expect(errorOutput.join("\n")).toContain(
			"configure get does not take a registry source.",
		);
	});

	test("it should print an error and exit 1 without dispatching when `configure unset` is given a source because the unset action does not take a source", async () => {
		await runConfigureCli(["configure", "unset", "/tmp/registry.json"]);
		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(configUnsetMock).not.toHaveBeenCalled();
		expect(errorOutput.join("\n")).toContain(
			"configure unset does not take a registry source.",
		);
	});

	test.each([
		"bogus",
		"Get",
		"",
	])("it should print an error and exit 1 with usage guidance for an unknown action `%s` when parsing because the action is not one of get, set, or unset", async (action) => {
		await runConfigureCli(["configure", action]);
		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain(
			`Unknown configure action "${action}"`,
		);
		expect(errorOutput.join("\n")).toContain(
			"Usage: cheetos configure <get|set|unset> [source]",
		);
	});
});

describe("add command pre-run source validation", () => {
	let errorOutput: string[];
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		addMock.mockClear();
		configGetMock.mockClear();
		configSetMock.mockClear();
		configUnsetMock.mockClear();
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
		restoreIsTTY();
		vi.restoreAllMocks();
	});

	test("it should prompt to add a source and retry the load once when no source is configured on a TTY because an interactive user can fix the problem inline", async () => {
		stubIsTTY(true);
		const fakeRegistry: LoadedRegistry = {
			registry: {} as Registry,
			indexLocation: "/fake/registry.json",
		};
		let loadCalls = 0;
		const loadRegistry = vi.fn(async () => {
			loadCalls += 1;
			if (loadCalls === 1) throw noRegistrySourceError();
			return fakeRegistry;
		});
		configSetMock.mockResolvedValue("/fake/config.json");

		await runAddCli(loadRegistry);

		await vi.waitFor(() => expect(addMock).toHaveBeenCalledTimes(1));
		expect(configSetMock).toHaveBeenCalledTimes(1);
		expect(configSetMock).toHaveBeenCalledWith(undefined);
		expect(loadRegistry).toHaveBeenCalledTimes(2);
		expect(addMock.mock.calls[0]?.[0]).toBe(fakeRegistry.registry);
		expect(addMock.mock.calls[0]?.[1]).toBe(fakeRegistry.indexLocation);
	});

	test("it should fail fast with exit 1 and no prompt when no source is configured on a non-TTY stream because an interactive prompt would hang CI", async () => {
		stubIsTTY(false);
		const loadRegistry = vi.fn(async () => {
			throw noRegistrySourceError();
		});

		await runAddCli(loadRegistry);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain("No registry source configured");
		expect(configSetMock).not.toHaveBeenCalled();
		expect(loadRegistry).toHaveBeenCalledTimes(1);
		expect(addMock).not.toHaveBeenCalled();
	});

	test("it should exit 0 without retrying the load when the source prompt is canceled because a cancel is not an error", async () => {
		stubIsTTY(true);
		const loadRegistry = vi.fn(async () => {
			throw noRegistrySourceError();
		});
		configSetMock.mockRejectedValue(new OperationCanceledError());

		await runAddCli(loadRegistry);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
		expect(loadRegistry).toHaveBeenCalledTimes(1);
		expect(addMock).not.toHaveBeenCalled();
	});

	test("it should surface a load error and not prompt twice when the source added at the prompt still fails to load because the retry is capped at one", async () => {
		stubIsTTY(true);
		const loadRegistry = vi.fn(async () => {
			throw noRegistrySourceError();
		});
		configSetMock.mockResolvedValue("/fake/config.json");

		await runAddCli(loadRegistry);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(configSetMock).toHaveBeenCalledTimes(1);
		expect(loadRegistry).toHaveBeenCalledTimes(2);
		expect(addMock).not.toHaveBeenCalled();
	});
});
