import type { Registry } from "@recipebook/core";
import cac, { type CAC } from "cac";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type MockInstance,
	test,
	vi,
} from "vitest";
import { animatedIntro } from "../../cli/animated-intro";
import { InterruptError, OperationCanceledError } from "../../cli/errors";
import type { LoadedRegistry } from "../../utils/registry";
import { addCommand } from "../add";
import {
	configGetCommand,
	configSetCommand,
	configUnsetCommand,
} from "../config";
import { registerCommandsCli } from "../index";

vi.mock("../add", () => ({ addCommand: vi.fn(async () => {}) }));
vi.mock("../config", () => ({
	configGetCommand: vi.fn(async () => {}),
	configSetCommand: vi.fn(async () => "/fake/config.json"),
	configUnsetCommand: vi.fn(async () => false),
}));
vi.mock("../../cli/animated-intro", () => ({
	animatedIntro: vi.fn(async () => {}),
}));

const addMock = vi.mocked(addCommand);
const animatedIntroMock = vi.mocked(animatedIntro);
const configGetMock = vi.mocked(configGetCommand);
const configSetMock = vi.mocked(configSetCommand);
const configUnsetMock = vi.mocked(configUnsetCommand);

function noRegistrySourceError(): Error {
	return Object.assign(
		new Error(
			"No registry source configured. Add one with `recipebook configure set <https URL or file path>`, set RECIPEBOOK_REGISTRY, or pass --registry <source>.",
		),
		{ name: "NoRegistrySourceError" },
	);
}

function stubIsTTY(value: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", {
		value,
		configurable: true,
	});
}

function restoreIsTTY(): void {
	delete (process.stdin as { isTTY?: boolean }).isTTY;
}

async function runAddCli(
	loadRegistry: () => Promise<LoadedRegistry>,
	args: string[] = [],
): Promise<void> {
	const app = cac("recipebook");
	registerCommandsCli(app, loadRegistry);
	await app.parse(["node", "recipebook", "add", ...args]);
}

describe("add command pre-run source validation", () => {
	let errorOutput: string[];
	let exitSpy: MockInstance<typeof process.exit>;

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
		expect(configSetMock).toHaveBeenCalledWith();
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
		// vader item 6: cancel must terminate — the error path must never run.
		expect(exitSpy).toHaveBeenCalledTimes(1);
		expect(errorOutput.join("\n")).not.toContain(" error  Operation canceled");
		expect(loadRegistry).toHaveBeenCalledTimes(1);
		expect(addMock).not.toHaveBeenCalled();
	});

	test("it should exit 130 without printing an error when command execution is interrupted because an interrupt terminates the CLI rather than falling through to the error handler", async () => {
		stubIsTTY(true);
		const loadRegistry = vi.fn(async () => {
			throw new InterruptError();
		});

		await runAddCli(loadRegistry);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130));
		// vader item 6 symmetric: an interrupt must terminate — the error path must never run.
		expect(exitSpy).toHaveBeenCalledTimes(1);
		expect(errorOutput.join("\n")).not.toContain(" error ");
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

describe("add command wiring", () => {
	let errorOutput: string[];
	let exitSpy: MockInstance<typeof process.exit>;

	beforeEach(() => {
		addMock.mockClear();
		animatedIntroMock.mockClear();
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

	test("it should dispatch addCommand with the parsed positional item and --overwrite option because silently dropping either would change what the user asked to install", async () => {
		stubIsTTY(true);
		const fakeRegistry: LoadedRegistry = {
			registry: {} as Registry,
			indexLocation: "/fake/registry.json",
		};

		await runAddCli(
			vi.fn(async () => fakeRegistry),
			["button", "--overwrite"],
		);

		await vi.waitFor(() => expect(addMock).toHaveBeenCalledTimes(1));
		expect(addMock).toHaveBeenCalledWith(
			fakeRegistry.registry,
			fakeRegistry.indexLocation,
			{ items: ["button"], overwrite: true },
		);
	});

	test("it should dispatch addCommand with the parsed positional item and no overwrite option when --overwrite is absent because the flag must stay opt-in", async () => {
		stubIsTTY(true);
		const fakeRegistry: LoadedRegistry = {
			registry: {} as Registry,
			indexLocation: "/fake/registry.json",
		};

		await runAddCli(
			vi.fn(async () => fakeRegistry),
			["button"],
		);

		await vi.waitFor(() => expect(addMock).toHaveBeenCalledTimes(1));
		expect(addMock).toHaveBeenCalledWith(
			fakeRegistry.registry,
			fakeRegistry.indexLocation,
			{ items: ["button"], overwrite: undefined },
		);
	});

	test("it should dispatch addCommand with overwrite normalized to undefined when --no-overwrite is passed because CAC negates the boolean flag to false", async () => {
		stubIsTTY(true);
		const fakeRegistry: LoadedRegistry = {
			registry: {} as Registry,
			indexLocation: "/fake/registry.json",
		};

		await runAddCli(
			vi.fn(async () => fakeRegistry),
			["button", "--no-overwrite"],
		);

		await vi.waitFor(() => expect(addMock).toHaveBeenCalledTimes(1));
		expect(addMock).toHaveBeenCalledWith(
			fakeRegistry.registry,
			fakeRegistry.indexLocation,
			{ items: ["button"], overwrite: undefined },
		);
	});

	test("it should introduce the add flow with the add intro title because the intro copy is part of the command's user-facing surface", async () => {
		stubIsTTY(true);
		const fakeRegistry: LoadedRegistry = {
			registry: {} as Registry,
			indexLocation: "/fake/registry.json",
		};

		await runAddCli(
			vi.fn(async () => fakeRegistry),
			["button"],
		);

		await vi.waitFor(() => expect(addMock).toHaveBeenCalledTimes(1));
		expect(animatedIntroMock).toHaveBeenCalledWith("adding registry item");
	});

	test("it should print an error and exit 1 without dispatching when a second positional argument is passed because add installs one registry item at a time", async () => {
		stubIsTTY(true);
		const fakeRegistry: LoadedRegistry = {
			registry: {} as Registry,
			indexLocation: "/fake/registry.json",
		};

		await runAddCli(
			vi.fn(async () => fakeRegistry),
			["button", "other"],
		);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain(
			"add installs one registry item at a time",
		);
		expect(addMock).not.toHaveBeenCalled();
	});

	test("it should dispatch addCommand with an empty item list when no positional is passed because the interactive prompt lives inside the command and the wiring must still deliver an empty selection", async () => {
		stubIsTTY(true);
		const fakeRegistry: LoadedRegistry = {
			registry: {} as Registry,
			indexLocation: "/fake/registry.json",
		};

		await runAddCli(
			vi.fn(async () => fakeRegistry),
			[],
		);

		await vi.waitFor(() => expect(addMock).toHaveBeenCalledTimes(1));
		expect(addMock).toHaveBeenCalledWith(
			fakeRegistry.registry,
			fakeRegistry.indexLocation,
			{ items: [], overwrite: undefined },
		);
	});
});

describe("add command argument guards against parser contract drift", () => {
	// cac 6 coerces positionals to strings and `--flag=x` to `true`, so these
	// guards cannot fire through a real parse. Driving the registered action
	// directly through a duck-typed CAC double pins the fail-fast contract the
	// guards promise if the parser's behavior ever changes.
	interface FakeCommand {
		option: ReturnType<typeof vi.fn>;
		usage: ReturnType<typeof vi.fn>;
		action: ReturnType<typeof vi.fn>;
	}

	function fakeCacApp(): { app: CAC; command: FakeCommand } {
		const command: FakeCommand = {
			option: vi.fn(),
			usage: vi.fn(),
			action: vi.fn(),
		};
		const app = {
			command: vi.fn(() => command),
			args: [] as unknown[],
			parse: vi.fn(async () => {}),
		};
		return { app: app as unknown as CAC, command };
	}

	let errorOutput: string[];
	let exitSpy: MockInstance<typeof process.exit>;

	beforeEach(() => {
		errorOutput = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errorOutput.push(args.map((arg) => String(arg)).join(" "));
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined as never) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("it should print an error and exit 1 when the add positional is not a string because a parser that stops coercing positionals must hit a fail-fast guard, not a corrupt install", async () => {
		const { app, command } = fakeCacApp();
		registerCommandsCli(
			app,
			vi.fn(async () => ({ registry: {} as Registry, indexLocation: "/fake" })),
		);
		const addAction = command.action.mock.calls[0]?.[0] as (
			item: unknown,
			options: unknown,
		) => Promise<void>;

		await addAction(123, {});

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain(
			"add expected a registry item id.",
		);
		expect(addMock).not.toHaveBeenCalled();
	});

	test("it should treat a missing app args list as having no extras because a host that never initializes args must not break the single-item contract", async () => {
		const { app, command } = fakeCacApp();
		(app as unknown as { args: unknown }).args = undefined;
		registerCommandsCli(
			app,
			vi.fn(async () => ({ registry: {} as Registry, indexLocation: "/fake" })),
		);
		const addAction = command.action.mock.calls[0]?.[0] as (
			item: unknown,
			options: unknown,
		) => Promise<void>;

		await addAction("button", {});

		await vi.waitFor(() => expect(addMock).toHaveBeenCalledTimes(1));
		expect(addMock).toHaveBeenCalledWith({} as Registry, "/fake", {
			items: ["button"],
			overwrite: undefined,
		});
	});

	test("it should print an error and exit 1 when the overwrite option is not a boolean because a mis-typed flag must fail loudly instead of installing with a surprise value", async () => {
		const { app, command } = fakeCacApp();
		registerCommandsCli(
			app,
			vi.fn(async () => ({ registry: {} as Registry, indexLocation: "/fake" })),
		);
		const addAction = command.action.mock.calls[0]?.[0] as (
			item: unknown,
			options: unknown,
		) => Promise<void>;

		await addAction("button", { overwrite: "yes" });

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain(
			"Option --overwrite must be a boolean flag.",
		);
		expect(addMock).not.toHaveBeenCalled();
	});
});
