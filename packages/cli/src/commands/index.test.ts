import type { Registry } from "@cheetos/core";
import cac, { type CAC } from "cac";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAddCommand = vi.fn();
const mockIntro = vi.fn();
const mockConfigGetCommand = vi.fn();
const mockConfigSetCommand = vi.fn();
const mockConfigUnsetCommand = vi.fn();
const mockLoadRegistry = vi.fn();

vi.mock("./add", () => ({
	addCommand: (...args: unknown[]) => mockAddCommand(...args),
}));

vi.mock("./config", () => ({
	configGetCommand: (...args: unknown[]) => mockConfigGetCommand(...args),
	configSetCommand: (...args: unknown[]) => mockConfigSetCommand(...args),
	configUnsetCommand: (...args: unknown[]) => mockConfigUnsetCommand(...args),
}));

vi.mock("../cli/animated-intro", () => ({
	animatedIntro: (...args: unknown[]) => mockIntro(...args),
}));

import { registerCommandsCli } from "./index";

function createMockApp() {
	const actions = new Map<string, (...args: unknown[]) => Promise<void>>();
	const option = vi.fn().mockReturnThis();
	const usage = vi.fn().mockReturnThis();
	const command = vi.fn((name: string) => {
		const commandApi = {
			option,
			usage,
			action: (handler: (...args: unknown[]) => Promise<void>) => {
				actions.set(name, handler);
				return commandApi;
			},
		};
		return commandApi;
	});

	const app = {
		command,
	};

	return {
		app: app as unknown as CAC,
		command,
		option,
		usage,
		actions,
	};
}

describe("commands/index", () => {
	const registry = {
		types: {
			component: { label: "Components" },
			theme: { label: "Themes" },
		},
		items: {
			"theme-a": {
				id: "theme-a",
				title: "Theme A",
				description: "A theme",
				type: "theme",
				packs: [],
			},
		},
	} as Registry;

	let processExitSpy: ReturnType<typeof vi.fn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		processExitSpy = vi.fn();
		Object.defineProperty(process, "exit", {
			configurable: true,
			value: ((code?: string | number | null) => {
				processExitSpy(code);
				throw new Error(`process.exit called with code ${code ?? undefined}`);
			}) as typeof process.exit,
		});

		mockAddCommand.mockResolvedValue(undefined);
		mockIntro.mockResolvedValue(undefined);
		mockConfigGetCommand.mockResolvedValue(undefined);
		mockConfigSetCommand.mockResolvedValue("/tmp/config.json");
		mockConfigUnsetCommand.mockResolvedValue(true);
		mockLoadRegistry.mockResolvedValue({
			registry,
			indexLocation: "/workspace/registry.json",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * Assert a command action exits with code 1 and prints the message.
	 * @param action - Command action promise.
	 * @param message - Expected error text fragment.
	 */
	async function expectCommandError(
		action: Promise<void> | undefined,
		message: string,
	): Promise<void> {
		await expect(action).rejects.toThrow("process.exit called with code 1");
		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining(message),
		);
	}

	it("registers the add and nested config commands", () => {
		const { app, command, option, usage } = createMockApp();

		registerCommandsCli(app, mockLoadRegistry);

		expect(command).toHaveBeenCalledWith(
			"add [...items]",
			"Add a registry item to the current working directory",
		);
		expect(command).toHaveBeenCalledWith(
			"config <action> [source]",
			"Get, set, or unset the default registry source",
		);
		expect(option).toHaveBeenCalledWith(
			"--overwrite",
			"Overwrite existing files",
		);
		expect(usage).toHaveBeenCalledWith("config <get|set|unset> [source]");
	});

	it("runs the add command action with no positional items", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await actions.get("add [...items]")?.([], {});

		expect(mockAddCommand).toHaveBeenCalledWith(
			registry,
			"/workspace/registry.json",
			{
				items: [],
				overwrite: undefined,
			},
		);
	});

	it("treats omitted add items as an empty list", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await actions.get("add [...items]")?.(undefined, {});

		expect(mockAddCommand).toHaveBeenCalledWith(
			registry,
			"/workspace/registry.json",
			{
				items: [],
				overwrite: undefined,
			},
		);
	});

	it("runs the add command action with positional items and --overwrite", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await actions.get("add [...items]")?.(["pr-template-configuration"], {
			overwrite: true,
		});

		expect(mockLoadRegistry).toHaveBeenCalled();
		expect(mockIntro).toHaveBeenCalledWith("adding registry item");
		expect(mockAddCommand).toHaveBeenCalledWith(
			registry,
			"/workspace/registry.json",
			{
				items: ["pr-template-configuration"],
				overwrite: true,
			},
		);
	});

	it("rejects more than one positional add item", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await expectCommandError(
			actions.get("add [...items]")?.(
				["pr-template-configuration", "license"],
				{},
			),
			"add installs one registry item at a time.",
		);
		expect(mockAddCommand).not.toHaveBeenCalled();
	});

	it("runs config get without loading the registry", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await actions.get("config <action> [source]")?.("get");

		expect(mockLoadRegistry).not.toHaveBeenCalled();
		expect(mockIntro).toHaveBeenCalledWith("fetching the configuration");
		expect(mockConfigGetCommand).toHaveBeenCalledWith();
	});

	it("rejects an empty config action", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await expectCommandError(
			actions.get("config <action> [source]")?.(""),
			'Unknown config action ""',
		);
		expect(mockConfigGetCommand).not.toHaveBeenCalled();
	});

	it("runs config set with the provided source", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await actions.get("config <action> [source]")?.(
			"set",
			"https://example.com/registry.json",
		);

		expect(mockIntro).toHaveBeenCalledWith("updating the configuration");
		expect(mockConfigSetCommand).toHaveBeenCalledWith(
			"https://example.com/registry.json",
		);
	});

	it("runs config set without a source so the command can prompt", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await actions.get("config <action> [source]")?.("set");

		expect(mockConfigSetCommand).toHaveBeenCalledWith(undefined);
	});

	it("runs config unset", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await actions.get("config <action> [source]")?.("unset");

		expect(mockIntro).toHaveBeenCalledWith("clearing the configuration");
		expect(mockConfigUnsetCommand).toHaveBeenCalled();
	});

	it("exits on config set failures", async () => {
		const { app, actions } = createMockApp();
		mockConfigSetCommand.mockRejectedValue(new Error("bad source"));
		registerCommandsCli(app, mockLoadRegistry);

		await expectCommandError(
			actions.get("config <action> [source]")?.("set", "nope"),
			"bad source",
		);
	});

	it("rejects an unknown config action", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await expectCommandError(
			actions.get("config <action> [source]")?.("nope"),
			'Unknown config action "nope"',
		);
		expect(mockConfigGetCommand).not.toHaveBeenCalled();
	});

	it("rejects a non-string config action", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await expectCommandError(
			actions.get("config <action> [source]")?.(1),
			'Unknown config action "1"',
		);
	});

	it("rejects a non-string config source", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await expectCommandError(
			actions.get("config <action> [source]")?.("set", 42),
			"config source must be a string.",
		);
		expect(mockConfigSetCommand).not.toHaveBeenCalled();
	});

	it("rejects config get with a source argument", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await expectCommandError(
			actions.get("config <action> [source]")?.(
				"get",
				"https://example.com/registry.json",
			),
			"config get does not take a registry source.",
		);
		expect(mockConfigGetCommand).not.toHaveBeenCalled();
	});

	it("rejects config unset with a source argument", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await expectCommandError(
			actions.get("config <action> [source]")?.(
				"unset",
				"https://example.com/registry.json",
			),
			"config unset does not take a registry source.",
		);
		expect(mockConfigUnsetCommand).not.toHaveBeenCalled();
	});

	it("rejects a non-string add item list", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await expectCommandError(
			actions.get("add [...items]")?.("license", {}),
			"add expected a list of item ids.",
		);
		expect(mockAddCommand).not.toHaveBeenCalled();
	});

	it("rejects a non-boolean --overwrite value", async () => {
		const { app, actions } = createMockApp();
		registerCommandsCli(app, mockLoadRegistry);

		await expectCommandError(
			actions.get("add [...items]")?.([], { overwrite: "yes" }),
			"Option --overwrite must be a boolean flag.",
		);
		expect(mockAddCommand).not.toHaveBeenCalled();
	});

	it("matches config get/set/unset against real CAC argv", async () => {
		const app = cac("cheetos");
		registerCommandsCli(app, mockLoadRegistry);

		app.parse(["node", "cheetos", "config", "get"], { run: false });
		await app.runMatchedCommand();
		expect(mockConfigGetCommand).toHaveBeenCalledWith();
		expect(mockLoadRegistry).not.toHaveBeenCalled();

		mockConfigGetCommand.mockClear();
		app.parse(
			["node", "cheetos", "config", "set", "https://example.com/registry.json"],
			{ run: false },
		);
		await app.runMatchedCommand();
		expect(mockConfigSetCommand).toHaveBeenCalledWith(
			"https://example.com/registry.json",
		);

		app.parse(["node", "cheetos", "config", "unset"], { run: false });
		await app.runMatchedCommand();
		expect(mockConfigUnsetCommand).toHaveBeenCalled();
	});

	it("rejects config get with a source against real CAC argv", async () => {
		const app = cac("cheetos");
		registerCommandsCli(app, mockLoadRegistry);

		app.parse(
			["node", "cheetos", "config", "get", "https://example.com/registry.json"],
			{ run: false },
		);
		await expectCommandError(
			app.runMatchedCommand(),
			"config get does not take a registry source.",
		);
		expect(mockConfigGetCommand).not.toHaveBeenCalled();
	});

	it("lets CAC reject bare config when the required action is missing", async () => {
		const app = cac("cheetos");
		registerCommandsCli(app, mockLoadRegistry);

		app.parse(["node", "cheetos", "config"], { run: false });
		expect(() => app.runMatchedCommand()).toThrow(
			"missing required args for command `config <action> [source]`",
		);
		expect(mockConfigGetCommand).not.toHaveBeenCalled();
	});

	it("matches add against real CAC argv, including a single item and --overwrite", async () => {
		const app = cac("cheetos");
		registerCommandsCli(app, mockLoadRegistry);

		app.parse(["node", "cheetos", "add"], { run: false });
		await app.runMatchedCommand();
		expect(mockAddCommand).toHaveBeenCalledWith(
			registry,
			"/workspace/registry.json",
			{
				items: [],
				overwrite: undefined,
			},
		);

		mockAddCommand.mockClear();
		app.parse(["node", "cheetos", "add", "pr-template-configuration"], {
			run: false,
		});
		await app.runMatchedCommand();
		expect(mockAddCommand).toHaveBeenCalledWith(
			registry,
			"/workspace/registry.json",
			{
				items: ["pr-template-configuration"],
				overwrite: undefined,
			},
		);

		mockAddCommand.mockClear();
		app.parse(
			["node", "cheetos", "add", "pr-template-configuration", "--overwrite"],
			{ run: false },
		);
		await app.runMatchedCommand();
		expect(mockAddCommand).toHaveBeenCalledWith(
			registry,
			"/workspace/registry.json",
			{
				items: ["pr-template-configuration"],
				overwrite: true,
			},
		);
	});
});
