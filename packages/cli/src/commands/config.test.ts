import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockTextInput = vi.fn();
const mockReadJsonFileAsync = vi.fn();

vi.mock("../cli/prompts", () => ({
	textInput: (...args: unknown[]) => mockTextInput(...args),
}));

vi.mock("@cheetos/core", async () => {
	const actual =
		await vi.importActual<typeof import("@cheetos/core")>("@cheetos/core");
	return {
		...actual,
		readJsonFileAsync: (...args: unknown[]) => mockReadJsonFileAsync(...args),
	};
});

import {
	configGetCommand,
	configSetCommand,
	configUnsetCommand,
} from "./config";

describe("commands/config", () => {
	const tempRoots: string[] = [];

	beforeEach(() => {
		mockReadJsonFileAsync.mockResolvedValue({ version: "1.2.3" });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mockTextInput.mockReset();
		mockReadJsonFileAsync.mockReset();
		await Promise.all(
			tempRoots.splice(0).map(async (root) => {
				await fs.promises.rm(root, { recursive: true, force: true });
			}),
		);
	});

	/**
	 * Create an isolated temp directory for config path injection.
	 * @returns Absolute temp directory path.
	 */
	async function makeTempRoot(): Promise<string> {
		const root = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), "cheetos-config-cmd-"),
		);
		tempRoots.push(root);
		return root;
	}

	describe("configSetCommand / configGetCommand / configUnsetCommand", () => {
		it("sets, gets, and unsets a registry URL", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			mockReadJsonFileAsync.mockResolvedValue({ version: "1.2.3" });

			await configSetCommand("https://example.com/registry.json", env);

			await configGetCommand(env);

			const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
			expect(output).toContain("Configuration");
			expect(output).toContain("https://example.com/registry.json");
			expect(output).toContain(path.join(root, "cheetos", "config.json"));

			await expect(configUnsetCommand(env)).resolves.toBe(true);
			await expect(configUnsetCommand(env)).resolves.toBe(false);
		});

		it("persists a local path as absolute from the set-time cwd", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			const registryFile = path.join(root, "registry.json");
			await fs.promises.writeFile(registryFile, "{}\n");
			const workDir = path.join(root, "workdir");
			await fs.promises.mkdir(workDir);
			vi.spyOn(process, "cwd").mockReturnValue(workDir);
			vi.spyOn(console, "log").mockImplementation(() => {});

			const relative = path.relative(workDir, registryFile);
			await configSetCommand(relative, env);

			const saved = JSON.parse(
				await fs.promises.readFile(
					path.join(root, "cheetos", "config.json"),
					"utf8",
				),
			) as { registry: string };
			expect(saved.registry).toBe(registryFile);
			expect(path.isAbsolute(saved.registry)).toBe(true);
		});

		it.each([
			{
				label: "HTTP URLs",
				source: "http://example.com/registry.json",
				message: "Remote registries must use HTTPS",
			},
			{
				label: "localhost registry URLs",
				source: "https://localhost/registry.json",
				message: "Remote registries cannot target localhost.",
			},
			{
				label: "registry URLs with credentials",
				source: "https://user:secret@example.com/registry.json",
				message: "Remote registries must not include credentials.",
			},
		])("rejects $label", async ({ source, message }) => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			vi.spyOn(console, "log").mockImplementation(() => {});

			await expect(configSetCommand(source, env)).rejects.toThrow(message);
		});

		it("prompts for a source when omitted", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			vi.spyOn(console, "log").mockImplementation(() => {});
			mockTextInput.mockResolvedValue("https://example.com/prompted.json");

			await configSetCommand(undefined, env);

			expect(mockTextInput).toHaveBeenCalledWith(
				"Registry URL or local path",
				expect.objectContaining({
					placeholder: "https://example.com/registry.json",
					required: true,
				}),
			);
			const saved = JSON.parse(
				await fs.promises.readFile(
					path.join(root, "cheetos", "config.json"),
					"utf8",
				),
			) as { registry: string };
			expect(saved.registry).toBe("https://example.com/prompted.json");
		});

		it("prompts for a source when the provided value is whitespace", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			vi.spyOn(console, "log").mockImplementation(() => {});
			mockTextInput.mockResolvedValue("https://example.com/prompted.json");

			await configSetCommand("   ", env);

			expect(mockTextInput).toHaveBeenCalled();
		});

		it("rejects invalid sources without writing config", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			vi.spyOn(console, "log").mockImplementation(() => {});
			mockTextInput.mockResolvedValue("");

			await expect(configSetCommand(undefined, env)).rejects.toThrow(
				"Registry source must not be empty.",
			);

			await expect(configSetCommand("./nope.json", env)).rejects.toThrow(
				"does not exist",
			);

			await expect(configGetCommand({ ...env })).resolves.toBeUndefined();
		});

		it("rejects a local path that is a directory", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			const registryDir = path.join(root, "registry-dir");
			await fs.promises.mkdir(registryDir);
			vi.spyOn(console, "log").mockImplementation(() => {});

			await expect(configSetCommand(registryDir, env)).rejects.toThrow(
				/is not a file/,
			);

			await expect(configGetCommand({ ...env })).resolves.toBeUndefined();
		});

		it("rejects a local path that is a symbolic link", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			const realFile = path.join(root, "registry.json");
			const link = path.join(root, "registry-link.json");
			await fs.promises.writeFile(realFile, "{}\n");
			await fs.promises.symlink(realFile, link);
			vi.spyOn(console, "log").mockImplementation(() => {});

			await expect(configSetCommand(link, env)).rejects.toThrow(
				/is a symbolic link/,
			);
		});

		it("rejects a local path that is neither a file nor a directory", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			vi.spyOn(console, "log").mockImplementation(() => {});
			vi.spyOn(fs.promises, "lstat").mockResolvedValueOnce({
				isSymbolicLink: () => false,
				isDirectory: () => false,
				isFile: () => false,
			} as fs.Stats);

			await expect(configSetCommand("/tmp/special-node", env)).rejects.toThrow(
				"neither a file nor a directory",
			);
		});

		it("rethrows unexpected lstat errors", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			const error = Object.assign(new Error("permission denied"), {
				code: "EACCES",
			});
			vi.spyOn(fs.promises, "lstat").mockRejectedValueOnce(error);

			await expect(configSetCommand("./registry.json", env)).rejects.toBe(
				error,
			);
		});

		it.each([
			"file:///tmp/registry.json",
			"ftp://example.com/registry.json",
		])("rejects non-HTTPS URL scheme %s", async (source) => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };

			await expect(configSetCommand(source, env)).rejects.toThrow(
				"Registry source must be an HTTPS URL or a local file path.",
			);
		});

		it("rejects a malformed HTTPS URL", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };

			await expect(configSetCommand("https://[", env)).rejects.toThrow(
				'Registry URL "https://[" is not a valid URL.',
			);
		});

		it("persists a canonical HTTPS registry URL", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			vi.spyOn(console, "log").mockImplementation(() => {});

			await configSetCommand("HTTPS://EXAMPLE.COM/registry.json", env);

			const saved = JSON.parse(
				await fs.promises.readFile(
					path.join(root, "cheetos", "config.json"),
					"utf8",
				),
			) as { registry: string };
			expect(saved.registry).toBe("https://example.com/registry.json");
		});

		it("prints the default registry URL when none is saved", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			mockReadJsonFileAsync.mockResolvedValue({ version: "1.2.3" });

			await configGetCommand(env);

			const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
			expect(output).toMatch(
				/registry:\s+https:\/\/raw\.githubusercontent\.com\/agrawal-rohit\/cheetos\/cheetos@1\.2\.3\/packages\/registry\/registry\.json/,
			);
			expect(output).toContain(path.join(root, "cheetos", "config.json"));
		});

		it("prints the default registry URL after unset", async () => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			mockReadJsonFileAsync.mockResolvedValue({ version: "1.2.3" });

			await configSetCommand("https://example.com/registry.json", env);
			logSpy.mockClear();

			await expect(configUnsetCommand(env)).resolves.toBe(true);

			const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
			expect(output).not.toContain("Restored the default registry.");
			expect(output).toMatch(
				/registry:\s+https:\/\/raw\.githubusercontent\.com\/agrawal-rohit\/cheetos\/cheetos@1\.2\.3\/packages\/registry\/registry\.json/,
			);
			expect(output).toContain(path.join(root, "cheetos", "config.json"));
		});

		it.each([
			{
				label: "a non-object package.json",
				pkg: null,
				message: "CLI package.json must be a JSON object.",
			},
			{
				label: "a package.json array",
				pkg: [],
				message: "CLI package.json must be a JSON object.",
			},
			{
				label: "a missing version",
				pkg: {},
				message: "CLI package.json is missing a version.",
			},
			{
				label: "a blank version",
				pkg: { version: "   " },
				message: "CLI package.json is missing a version.",
			},
			{
				label: "a version with a slash",
				pkg: { version: "1.0.0/evil" },
				message: "CLI package.json version is invalid.",
			},
			{
				label: "a version with path traversal",
				pkg: { version: "1.0.0.." },
				message: "CLI package.json version is invalid.",
			},
		])("rejects the default registry URL when CLI package.json is $label", async ({
			pkg,
			message,
		}) => {
			const root = await makeTempRoot();
			const env = { XDG_CONFIG_HOME: root };
			mockReadJsonFileAsync.mockResolvedValue(pkg);

			await expect(configGetCommand(env)).rejects.toThrow(message);
		});
	});
});
