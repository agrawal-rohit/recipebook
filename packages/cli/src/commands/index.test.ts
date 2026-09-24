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
import { animatedIntro } from "../cli/animated-intro";
import {
	InterruptError,
	OperationCanceledError,
	runCliCommand,
} from "../cli/errors";
import type { LoadedRegistry } from "../utils/registry";
import { addCommand } from "./add";
import { buildCommand } from "./build";
import {
	configGetCommand,
	configSetCommand,
	configUnsetCommand,
} from "./config";
import { registerCommandsCli } from "./index";

vi.mock("./add", () => ({ addCommand: vi.fn(async () => {}) }));
vi.mock("./build", () => ({ buildCommand: vi.fn(async () => {}) }));
vi.mock("./config", () => ({
	configGetCommand: vi.fn(async () => {}),
	configSetCommand: vi.fn(async () => "/fake/config.json"),
	configUnsetCommand: vi.fn(async () => false),
}));
vi.mock("../cli/animated-intro", () => ({
	animatedIntro: vi.fn(async () => {}),
}));

const addMock = vi.mocked(addCommand);
const buildMock = vi.mocked(buildCommand);
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

async function runConfigureCli(args: string[]): Promise<void> {
	const app = cac("recipebook");
	registerCommandsCli(app, async () => {
		throw new Error("registry loader must not run for configure commands");
	});
	await app.parse(["node", "recipebook", ...args]);
}

async function runBuildCli(args: string[]): Promise<void> {
	const app = cac("recipebook");
	registerCommandsCli(app, async () => {
		throw new Error("registry loader must not run for the build command");
	});
	await app.parse(["node", "recipebook", ...args]);
}

async function runAddCli(
	loadRegistry: () => Promise<LoadedRegistry>,
	args: string[] = [],
): Promise<void> {
	const app = cac("recipebook");
	registerCommandsCli(app, loadRegistry);
	await app.parse(["node", "recipebook", "add", ...args]);
}

describe("configure command wiring", () => {
	let errorOutput: string[];
	let exitSpy: MockInstance<typeof process.exit>;

	beforeEach(() => {
		addMock.mockClear();
		configGetMock.mockClear();
		configSetMock.mockClear();
		configUnsetMock.mockClear();
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
			"Usage: recipebook configure <get|set|unset> [source]",
		);
	});

	test("it should introduce `configure get` with the fetching intro title because each configure action announces its own user-facing copy", async () => {
		await runConfigureCli(["configure", "get"]);
		await vi.waitFor(() => expect(configGetMock).toHaveBeenCalledTimes(1));
		expect(animatedIntroMock).toHaveBeenCalledWith(
			"fetching the configuration",
		);
	});

	test("it should introduce `configure set` with the updating intro title because each configure action announces its own user-facing copy", async () => {
		await runConfigureCli(["configure", "set"]);
		await vi.waitFor(() => expect(configSetMock).toHaveBeenCalledTimes(1));
		expect(animatedIntroMock).toHaveBeenCalledWith(
			"updating the configuration",
		);
	});

	test("it should introduce `configure unset` with the clearing intro title because each configure action announces its own user-facing copy", async () => {
		await runConfigureCli(["configure", "unset"]);
		await vi.waitFor(() => expect(configUnsetMock).toHaveBeenCalledTimes(1));
		expect(animatedIntroMock).toHaveBeenCalledWith(
			"clearing the configuration",
		);
	});
});

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

describe("command argument guards against parser contract drift", () => {
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

	test("it should print an error and exit 1 when the configure source is not a string because a parser that stops coercing positionals must hit a fail-fast guard", async () => {
		const { app, command } = fakeCacApp();
		registerCommandsCli(
			app,
			vi.fn(async () => {
				throw new Error("registry loader must not run");
			}),
		);
		const configureAction = command.action.mock.calls[1]?.[0] as (
			action: unknown,
			source: unknown,
		) => Promise<void>;

		await configureAction("set", 123);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain(
			"configure source must be a string.",
		);
		expect(configSetMock).not.toHaveBeenCalled();
	});

	test("it should print an error and exit 1 with usage guidance when the configure action is not a string because a non-string action token must fail loudly", async () => {
		const { app, command } = fakeCacApp();
		registerCommandsCli(
			app,
			vi.fn(async () => {
				throw new Error("registry loader must not run");
			}),
		);
		const configureAction = command.action.mock.calls[1]?.[0] as (
			action: unknown,
			source: unknown,
		) => Promise<void>;

		await configureAction(42, undefined);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain('Unknown configure action "42"');
		expect(errorOutput.join("\n")).toContain(
			"Usage: recipebook configure <get|set|unset> [source]",
		);
	});
});

describe("build command wiring", () => {
	let errorOutput: string[];
	let exitSpy: MockInstance<typeof process.exit>;

	beforeEach(() => {
		buildMock.mockClear();
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
		vi.restoreAllMocks();
	});

	test("it should dispatch buildCommand with the default sourceDir and outDir when no positionals or flags are given because a bare `recipebook build` compiles ./ into dist", async () => {
		await runBuildCli(["build"]);

		await vi.waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
		expect(buildMock).toHaveBeenCalledWith(".", "dist", {});
		expect(exitSpy).not.toHaveBeenCalled();
	});

	test("it should dispatch buildCommand with the parsed positionals and every override flag because each flag must map to its core option", async () => {
		await runBuildCli([
			"build",
			"registry-src",
			"registry-dist",
			"--registry-file-name",
			"index.json",
			"--item-manifest-file-name",
			"manifest.json",
			"--types-file-name",
			"custom/types.json",
			"--conditions-file-name",
			"shared/conditions.json",
			"--compiled-dir-name",
			"compiled",
			// A single --external arrives from CAC as a string; the wiring must
			// normalize it to the string[] core expects.
			"--external",
			"lodash",
		]);

		await vi.waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
		expect(buildMock).toHaveBeenCalledWith("registry-src", "registry-dist", {
			registryFileName: "index.json",
			itemManifestFileName: "manifest.json",
			typesFileName: "custom/types.json",
			conditionsFileName: "shared/conditions.json",
			compiledDirName: "compiled",
			bundleExternalPackages: ["lodash"],
		});
	});

	test("it should collect repeated --external flags into one package list because the flag is repeatable", async () => {
		await runBuildCli(["build", "--external", "a", "--external", "b"]);

		await vi.waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
		expect(buildMock).toHaveBeenCalledWith(".", "dist", {
			bundleExternalPackages: ["a", "b"],
		});
	});

	test("it should print an error and exit 1 without dispatching when tokens trail the two positionals because build takes at most a source directory and an output directory and one package per --external flag", async () => {
		await runBuildCli(["build", "--external", "chalk", "lodash", "src", "out"]);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain(
			"build takes at most a source directory and an output directory; pass one package per --external flag.",
		);
		expect(buildMock).not.toHaveBeenCalled();
	});

	test('it should print an error and exit 1 without dispatching when tokens follow a bare -- because CAC hides them in options["--"] and silently dropping them would build the wrong directories', async () => {
		await runBuildCli(["build", "--", "/tmp/other-src", "/tmp/intended-out"]);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain(
			'build does not accept arguments after "--"; pass the source and output directories as regular positional arguments.',
		);
		expect(buildMock).not.toHaveBeenCalled();
	});

	test("it should print an error and exit 1 without dispatching when tokens follow -- after other flags because post--- tokens are never bound to positionals and must not be silently dropped", async () => {
		await runBuildCli([
			"build",
			"--external",
			"a",
			"--",
			"registry-src",
			"registry-out",
		]);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain(
			'build does not accept arguments after "--"; pass the source and output directories as regular positional arguments.',
		);
		expect(buildMock).not.toHaveBeenCalled();
	});

	test("it should print an error and exit 1 without dispatching when a repeated --external ends without a value because the trailing valueless flag arrives as `true` inside the package list and must demand a value", async () => {
		await runBuildCli(["build", "--external", "a", "--external"]);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain("--external requires a value");
		expect(buildMock).not.toHaveBeenCalled();
	});

	test("it should introduce the build flow with the building intro title because the intro copy is part of the command's user-facing surface", async () => {
		await runBuildCli(["build"]);

		await vi.waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
		expect(animatedIntroMock).toHaveBeenCalledWith("building the registry");
	});

	test("it should fail fast when --external is given without a value because CAC rejects a valueless required option before any dispatch", async () => {
		await expect(runBuildCli(["build", "--external"])).rejects.toThrow(
			"value is missing",
		);
		expect(buildMock).not.toHaveBeenCalled();
	});
});

describe("build command argument guards against parser contract drift", () => {
	// cac coerces positionals and `--flag=x` to strings, so these guards cannot
	// fire through a real parse. Driving the registered build action directly
	// through a duck-typed CAC double pins the fail-fast contract the guards
	// promise if the parser's behavior ever changes.
	interface FakeCommand {
		option: ReturnType<typeof vi.fn>;
		usage: ReturnType<typeof vi.fn>;
		action: ReturnType<typeof vi.fn>;
	}

	function fakeCacApp(): {
		app: CAC;
		buildAction: (
			sourceDir: unknown,
			outDir: unknown,
			options: unknown,
		) => Promise<void>;
		optionCalls: [string, string][];
	} {
		const command: FakeCommand = {
			option: vi.fn(),
			usage: vi.fn(),
			action: vi.fn(),
		};
		const commandNames: string[] = [];
		const app = {
			command: vi.fn((name: string) => {
				commandNames.push(name);
				return command;
			}),
			args: [] as unknown[],
			parse: vi.fn(async () => {}),
		};
		registerCommandsCli(
			app as unknown as CAC,
			vi.fn(async () => ({
				registry: {} as Registry,
				indexLocation: "/fake",
			})),
		);
		const buildIndex = commandNames.findIndex((name) =>
			name.startsWith("build"),
		);
		if (buildIndex === -1) throw new Error("build command is not registered.");
		const buildAction = command.action.mock.calls[buildIndex]?.[0] as (
			sourceDir: unknown,
			outDir: unknown,
			options: unknown,
		) => Promise<void>;
		return {
			app: app as unknown as CAC,
			buildAction,
			optionCalls: command.option.mock.calls as [string, string][],
		};
	}

	let errorOutput: string[];
	let exitSpy: MockInstance<typeof process.exit>;

	beforeEach(() => {
		buildMock.mockClear();
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

	test("it should declare --external as one value per flag because CAC does not implement variadic options and the declaration must not advertise a form it cannot parse", () => {
		const { optionCalls } = fakeCacApp();

		const externalDecl = optionCalls.find(([name]) =>
			name.startsWith("--external"),
		);
		expect(externalDecl?.[0]).toBe("--external <package>");
	});

	test("it should print an error and exit 1 when the sourceDir positional is not a string because a parser that stops coercing positionals must hit a fail-fast guard, not a corrupt build", async () => {
		const { buildAction } = fakeCacApp();

		await buildAction(123, "dist", {});

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain("must be a string");
		expect(buildMock).not.toHaveBeenCalled();
	});

	test("it should print an error and exit 1 when a build flag value is not a string because a mis-typed option must fail loudly instead of building with a surprise value", async () => {
		const { buildAction } = fakeCacApp();

		await buildAction(".", "dist", { registryFileName: 42 });

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain("must be a string");
		expect(buildMock).not.toHaveBeenCalled();
	});

	test("it should print an error and exit 1 when a build flag arrives as `true` because a valueless flag must demand a value instead of silently building with a default", async () => {
		const { buildAction } = fakeCacApp();

		await buildAction(".", "dist", { typesFileName: true });

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain("requires a value");
		expect(buildMock).not.toHaveBeenCalled();
	});

	test("it should print an error and exit 1 when --external arrives as `true` because a valueless repeatable flag must fail fast instead of passing a non-list to core", async () => {
		const { buildAction } = fakeCacApp();

		await buildAction(".", "dist", { external: true });

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain("requires a value");
		expect(buildMock).not.toHaveBeenCalled();
	});
});

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
