import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock CLI dependencies used by the top-level entrypoint
const mockApp = {
	help: vi.fn().mockReturnThis(),
	option: vi.fn().mockReturnThis(),
	outputHelp: vi.fn(),
	parse: vi.fn(),
	runMatchedCommand: vi.fn(),
	matchedCommand: undefined as { name?: string } | undefined,
	matchedCommandName: undefined as string | undefined,
	options: {} as Record<string, unknown>,
};

vi.mock("cac", () => ({
	default: vi.fn(() => mockApp),
}));

vi.mock("./commands", () => ({
	registerCommandsCli: vi.fn(async () => {}),
}));

vi.mock("./utils/registry", () => ({
	loadRuntimeRegistry: vi.fn(async () => ({
		registry: { items: {} },
		indexLocation: "/bundle/registry.json",
	})),
}));

vi.mock("./cli/config", () => ({
	readConfig: vi.fn(async () => ({})),
}));

import cac from "cac";
import { readConfig } from "./cli/config";
import { registerCommandsCli } from "./commands";
import run from "./index";
import { loadRuntimeRegistry } from "./utils/registry";

/** Default shape returned by cac's `parse(..., { run: false })`. */
function emptyParseResult() {
	return { args: [] as string[], options: {} as Record<string, unknown> };
}

describe("index", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockApp.matchedCommand = undefined;
		mockApp.matchedCommandName = undefined;
		mockApp.options = {};
		vi.mocked(registerCommandsCli).mockReturnValue(undefined);
		vi.mocked(readConfig).mockResolvedValue({});
		vi.mocked(mockApp.parse).mockReturnValue(emptyParseResult());
		vi.mocked(mockApp.runMatchedCommand).mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("run", () => {
		it("should initialize CAC with correct name and register the commands CLI", async () => {
			vi.stubGlobal("process", { argv: ["node", "pebbles"] });

			await run();

			expect(cac).toHaveBeenCalledWith("pebbles");
			expect(mockApp.option).toHaveBeenCalledWith(
				"--registry <source>",
				"Use a custom registry URL",
			);
			expect(registerCommandsCli).toHaveBeenCalledWith(
				mockApp,
				expect.any(Function),
			);
			expect(mockApp.help).toHaveBeenCalled();
			expect(mockApp.parse).toHaveBeenCalledWith(["node", "pebbles"], {
				run: false,
			});
			expect(mockApp.runMatchedCommand).toHaveBeenCalledTimes(1);
		});

		it("should output help when no arguments are provided", async () => {
			vi.stubGlobal("process", { argv: ["node", "pebbles"] });

			await run();

			expect(mockApp.parse).toHaveBeenCalledWith(["node", "pebbles"], {
				run: false,
			});
			expect(mockApp.runMatchedCommand).toHaveBeenCalledTimes(1);
			expect(mockApp.outputHelp).toHaveBeenCalled();
		});

		it("should parse arguments when provided", async () => {
			const argv = ["node", "pebbles", "list"];
			vi.stubGlobal("process", { argv });
			mockApp.matchedCommand = { name: "list" };
			mockApp.matchedCommandName = "list";

			await run();

			expect(mockApp.parse).toHaveBeenCalledTimes(1);
			expect(mockApp.parse).toHaveBeenCalledWith(argv, { run: false });
			expect(mockApp.runMatchedCommand).toHaveBeenCalledTimes(1);
			expect(mockApp.outputHelp).not.toHaveBeenCalled();
		});

		it("should output help when no command matches", async () => {
			const argv = ["node", "pebbles", "nope"];
			vi.stubGlobal("process", { argv });
			mockApp.matchedCommand = undefined;

			await run();

			expect(mockApp.parse).toHaveBeenCalledWith(argv, { run: false });
			expect(mockApp.runMatchedCommand).toHaveBeenCalled();
			expect(mockApp.outputHelp).toHaveBeenCalled();
		});

		it("should not re-print help after cac already handled --help", async () => {
			const argv = ["node", "pebbles", "config", "--help"];
			vi.stubGlobal("process", { argv });
			mockApp.matchedCommand = undefined;
			mockApp.matchedCommandName = undefined;
			mockApp.options = { help: true };

			await run();

			expect(mockApp.runMatchedCommand).toHaveBeenCalled();
			expect(mockApp.outputHelp).not.toHaveBeenCalled();
		});

		it("should surface CAC validation errors from the matched command", async () => {
			const argv = ["node", "pebbles", "package"];
			vi.stubGlobal("process", { argv });
			vi.mocked(mockApp.runMatchedCommand).mockRejectedValue(
				new Error("Unknown option `--wat`"),
			);

			await expect(run()).rejects.toThrow("Unknown option `--wat`");
			expect(mockApp.parse).toHaveBeenCalledTimes(1);
			expect(mockApp.parse).toHaveBeenCalledWith(argv, { run: false });
			expect(mockApp.runMatchedCommand).toHaveBeenCalledTimes(1);
			expect(mockApp.outputHelp).not.toHaveBeenCalled();
		});

		it("should pass through a global --registry override before registration", async () => {
			const argv = [
				"node",
				"pebbles",
				"--registry",
				"https://example.com/registry.json",
				"list",
			];
			vi.stubGlobal("process", { argv });
			mockApp.matchedCommand = { name: "list" };
			mockApp.options = { registry: "https://example.com/registry.json" };
			vi.mocked(mockApp.parse).mockReturnValue({
				args: ["list"],
				options: { registry: "https://example.com/registry.json" },
			});

			await run();

			expect(mockApp.parse).toHaveBeenCalledWith(argv, { run: false });
			const loader = vi.mocked(registerCommandsCli).mock
				.calls[0]?.[1] as () => Promise<unknown>;
			expect(loader).toBeTypeOf("function");
			await loader();
			expect(loadRuntimeRegistry).toHaveBeenCalledWith(
				"https://example.com/registry.json",
			);
		});

		it("should pass through a global --registry=value override before registration", async () => {
			const argv = [
				"node",
				"pebbles",
				"--registry=https://example.com/registry.json",
				"list",
			];
			vi.stubGlobal("process", { argv });
			mockApp.matchedCommand = { name: "list" };
			mockApp.options = { registry: "https://example.com/registry.json" };
			vi.mocked(mockApp.parse).mockReturnValue({
				args: ["list"],
				options: { registry: "https://example.com/registry.json" },
			});

			await run();

			expect(mockApp.parse).toHaveBeenCalledWith(argv, { run: false });
			const loader = vi.mocked(registerCommandsCli).mock
				.calls[0]?.[1] as () => Promise<unknown>;
			await loader();
			expect(loadRuntimeRegistry).toHaveBeenCalledWith(
				"https://example.com/registry.json",
			);
		});

		it("should reject a boolean --registry flag when loading the registry", async () => {
			vi.stubGlobal("process", {
				argv: ["node", "pebbles", "list", "--registry"],
			});
			mockApp.matchedCommand = { name: "list" };
			mockApp.options = { registry: true };
			vi.mocked(mockApp.parse).mockReturnValue({
				args: ["list"],
				options: { registry: true },
			});

			await run();

			const loader = vi.mocked(registerCommandsCli).mock
				.calls[0]?.[1] as () => Promise<unknown>;
			await expect(loader()).rejects.toThrow(
				"--registry requires a non-empty URL or file path.",
			);
			expect(loadRuntimeRegistry).not.toHaveBeenCalled();
		});

		it("should reject an empty --registry value when loading the registry", async () => {
			vi.stubGlobal("process", {
				argv: ["node", "pebbles", "--registry=", "list"],
			});
			mockApp.matchedCommand = { name: "list" };
			mockApp.options = { registry: "" };
			vi.mocked(mockApp.parse).mockReturnValue({
				args: ["list"],
				options: { registry: "" },
			});

			await run();

			const loader = vi.mocked(registerCommandsCli).mock
				.calls[0]?.[1] as () => Promise<unknown>;
			await expect(loader()).rejects.toThrow(
				"--registry requires a non-empty URL or file path.",
			);
			expect(loadRuntimeRegistry).not.toHaveBeenCalled();
		});

		it("should trim a global --registry override", async () => {
			vi.stubGlobal("process", {
				argv: [
					"node",
					"pebbles",
					"--registry",
					"  https://example.com/registry.json  ",
					"list",
				],
			});
			mockApp.matchedCommand = { name: "list" };
			mockApp.options = { registry: "  https://example.com/registry.json  " };

			await run();

			const loader = vi.mocked(registerCommandsCli).mock
				.calls[0]?.[1] as () => Promise<unknown>;
			await loader();
			expect(loadRuntimeRegistry).toHaveBeenCalledWith(
				"https://example.com/registry.json",
			);
		});

		it("should forward a saved registry when no flag is present", async () => {
			vi.stubGlobal("process", { argv: ["node", "pebbles", "list"] });
			mockApp.matchedCommand = { name: "list" };
			vi.mocked(readConfig).mockResolvedValue({
				registry: "https://example.com/saved-registry.json",
			});

			await run();

			const loader = vi.mocked(registerCommandsCli).mock
				.calls[0]?.[1] as () => Promise<unknown>;
			await loader();
			expect(loadRuntimeRegistry).toHaveBeenCalledWith(
				undefined,
				"https://example.com/saved-registry.json",
			);
		});

		it("should prefer the flag over a saved registry without reading the config", async () => {
			vi.stubGlobal("process", {
				argv: [
					"node",
					"pebbles",
					"--registry",
					"https://example.com/flag-registry.json",
					"list",
				],
			});
			mockApp.matchedCommand = { name: "list" };
			mockApp.options = { registry: "https://example.com/flag-registry.json" };
			vi.mocked(readConfig).mockResolvedValue({
				registry: "https://example.com/saved-registry.json",
			});
			vi.mocked(mockApp.parse).mockReturnValue({
				args: ["list"],
				options: { registry: "https://example.com/flag-registry.json" },
			});

			await run();

			const loader = vi.mocked(registerCommandsCli).mock
				.calls[0]?.[1] as () => Promise<unknown>;
			await loader();
			expect(loadRuntimeRegistry).toHaveBeenCalledWith(
				"https://example.com/flag-registry.json",
			);
			expect(readConfig).not.toHaveBeenCalled();
		});

		it("should skip registry loading when only config commands run", async () => {
			vi.stubGlobal("process", {
				argv: ["node", "pebbles", "config", "get"],
			});
			mockApp.matchedCommand = { name: "config" };
			mockApp.matchedCommandName = "config";

			await run();

			expect(loadRuntimeRegistry).not.toHaveBeenCalled();
		});
	});
});
