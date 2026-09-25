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
import {
	configGetCommand,
	configSetCommand,
	configUnsetCommand,
} from "../config";
import { registerCommandsCli } from "../index";

vi.mock("../config", () => ({
	configGetCommand: vi.fn(async () => {}),
	configSetCommand: vi.fn(async () => "/fake/config.json"),
	configUnsetCommand: vi.fn(async () => false),
}));
vi.mock("../../cli/animated-intro", () => ({
	animatedIntro: vi.fn(async () => {}),
}));

const animatedIntroMock = vi.mocked(animatedIntro);
const configGetMock = vi.mocked(configGetCommand);
const configSetMock = vi.mocked(configSetCommand);
const configUnsetMock = vi.mocked(configUnsetCommand);

async function runConfigureCli(args: string[]): Promise<void> {
	const app = cac("recipebook");
	registerCommandsCli(app, async () => {
		throw new Error("registry loader must not run for configure commands");
	});
	await app.parse(["node", "recipebook", ...args]);
}

describe("configure command wiring", () => {
	let errorOutput: string[];
	let exitSpy: MockInstance<typeof process.exit>;

	beforeEach(() => {
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

describe("configure command argument guards against parser contract drift", () => {
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
