import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { configPath, readConfig, writeConfig } from "../cli/config";
import { textInput } from "../cli/prompts";
import {
	configGetCommand,
	configSetCommand,
	configUnsetCommand,
} from "./config";

vi.mock("../cli/prompts", () => ({ textInput: vi.fn() }));
vi.mock("../cli/animated-intro", () => ({
	animatedIntro: vi.fn(async () => {}),
}));

const textInputMock = vi.mocked(textInput);

function makeIsolatedEnv(): { root: string; env: NodeJS.ProcessEnv } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoinker-config-cmd-"));
	return { root, env: { XDG_CONFIG_HOME: root } };
}

describe("configSetCommand", () => {
	let root: string;
	let env: NodeJS.ProcessEnv;
	let printed: string[];

	beforeEach(() => {
		({ root, env } = makeIsolatedEnv());
		textInputMock.mockReset();
		printed = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			printed.push(args.map((arg) => String(arg)).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(path.join(process.cwd(), ".yoinker-cmd-test-cwd"), {
			recursive: true,
			force: true,
		});
	});

	test("it should persist an HTTPS source, return the config path, and never prompt when a source flag is given because a CLI-supplied source needs no interactive confirmation", async () => {
		const returned = await configSetCommand(
			"https://example.com/registry.json",
			env,
		);

		expect(returned).toBe(configPath(env));
		expect(textInputMock).not.toHaveBeenCalled();
		await expect(readConfig(env)).resolves.toEqual({
			registry: "https://example.com/registry.json",
		});
		expect(printed.join("\n")).toContain(
			"registry:    https://example.com/registry.json",
		);
		expect(printed.join("\n")).toContain("Configuration");
		expect(printed.join("\n")).toContain(configPath(env));
	});

	test("it should trim whitespace around the source before validating and storing when a source flag is given because a whitespace-padded argument is still the user's intended source", async () => {
		await configSetCommand("  https://example.com/registry.json  ", env);
		await expect(readConfig(env)).resolves.toEqual({
			registry: "https://example.com/registry.json",
		});
	});

	test("it should resolve a relative local path against the working directory when the source is not absolute because relative paths are interpreted from where the command runs", async () => {
		const cwdDir = path.join(process.cwd(), ".yoinker-cmd-test-cwd");
		fs.mkdirSync(cwdDir, { recursive: true });
		const registryFile = path.join(cwdDir, "registry.json");
		fs.writeFileSync(registryFile, "{}");

		await configSetCommand(".yoinker-cmd-test-cwd/registry.json", env);
		await expect(readConfig(env)).resolves.toEqual({ registry: registryFile });
	});

	test("it should persist an absolute local file path that exists when the source is absolute because a concrete file is a valid registry source", async () => {
		const registryFile = path.join(root, "registry.json");
		fs.writeFileSync(registryFile, "{}");

		await configSetCommand(registryFile, env);
		await expect(readConfig(env)).resolves.toEqual({ registry: registryFile });
	});

	test("it should prompt interactively and persist the answer when no source is given because the source must come from the user", async () => {
		textInputMock.mockResolvedValue("https://prompted.example.com/r.json");

		await configSetCommand(undefined, env);

		expect(textInputMock).toHaveBeenCalledTimes(1);
		expect(textInputMock).toHaveBeenCalledWith("Registry URL or local path", {
			placeholder: "https://example.com/registry.json",
			required: true,
		});
		await expect(readConfig(env)).resolves.toEqual({
			registry: "https://prompted.example.com/r.json",
		});
	});

	test("it should also trigger the prompt for a whitespace-only source because a whitespace-only argument carries no usable source", async () => {
		textInputMock.mockResolvedValue("https://prompted.example.com/r.json");

		await configSetCommand("   ", env);

		expect(textInputMock).toHaveBeenCalledTimes(1);
		await expect(readConfig(env)).resolves.toEqual({
			registry: "https://prompted.example.com/r.json",
		});
	});

	test("it should reject an empty prompt answer without writing when the prompt yields a blank source because the registry source must not be empty", async () => {
		// Production `textInput` always trims; an empty answer is the only way it
		// can still yield a blank source, exercising the empty-source guard.
		textInputMock.mockResolvedValue("");

		await expect(configSetCommand(undefined, env)).rejects.toThrow(
			"Registry source must not be empty.",
		);
		expect(fs.existsSync(configPath(env))).toBe(false);
	});

	test("it should replace a previously saved registry when setting because the new source supersedes the old one", async () => {
		await writeConfig({ registry: "https://old.example.com/r.json" }, env);

		await configSetCommand("https://new.example.com/r.json", env);

		await expect(readConfig(env)).resolves.toEqual({
			registry: "https://new.example.com/r.json",
		});
	});

	test("it should reject an HTTP (non-HTTPS) URL because remote registries must use HTTPS to avoid downgrade attacks", async () => {
		await expect(
			configSetCommand("http://example.com/registry.json", env),
		).rejects.toThrow("Remote registries must use HTTPS.");
		expect(fs.existsSync(configPath(env))).toBe(false);
	});

	test("it should reject a non-HTTP URL scheme because the source must be an HTTPS URL or a local file path", async () => {
		await expect(
			configSetCommand("ftp://example.com/registry.json", env),
		).rejects.toThrow(
			"Registry source must be an HTTPS URL or a local file path.",
		);
		expect(fs.existsSync(configPath(env))).toBe(false);
	});

	test("it should reject a malformed HTTPS URL because a malformed URL cannot resolve to a registry", async () => {
		await expect(configSetCommand("https://", env)).rejects.toThrow(
			'Registry URL "https://" is not a valid URL.',
		);
		expect(fs.existsSync(configPath(env))).toBe(false);
	});

	test("it should reject a URL with embedded credentials because embedding credentials leaks secrets into any saved config and logs", async () => {
		await expect(
			configSetCommand("https://user:pass@example.com/registry.json", env),
		).rejects.toThrow("Remote registries must not include credentials.");
		expect(fs.existsSync(configPath(env))).toBe(false);
	});

	test("it should reject localhost targets because a localhost target bypasses the published remote and could be an imposter", async () => {
		await expect(
			configSetCommand("https://localhost/registry.json", env),
		).rejects.toThrow("Remote registries cannot target localhost.");
		expect(fs.existsSync(configPath(env))).toBe(false);
	});

	test("it should reject subdomains of localhost because they resolve back to the local machine and are never the published remote", async () => {
		await expect(
			configSetCommand("https://registry.localhost/r.json", env),
		).rejects.toThrow("Remote registries cannot target localhost.");
		expect(fs.existsSync(configPath(env))).toBe(false);
	});

	test("it should reject IP-literal hosts because the registry must be reached via a verifiable hostname, not an IP address", async () => {
		await expect(
			configSetCommand("https://127.0.0.1/registry.json", env),
		).rejects.toThrow(
			"Remote registries must use a hostname, not an IP address.",
		);
		expect(fs.existsSync(configPath(env))).toBe(false);
	});

	test("it should reject a missing local path with a lookup hint when the local file does not exist because the user needs to know which path was searched", async () => {
		const missing = path.join(root, "no-such-registry.json");
		await expect(configSetCommand(missing, env)).rejects.toThrow(
			/does not exist \(looked up as .+no-such-registry\.json\)\./,
		);
		expect(fs.existsSync(configPath(env))).toBe(false);
	});

	test("it should not mistake an embedded `://` later in a local path for a URL scheme because a valid local path may legitimately contain that substring", async () => {
		const source = "nested/dir://registry.json";
		await expect(configSetCommand(source, env)).rejects.toThrow(
			'Registry path "nested/dir://registry.json" does not exist',
		);
		expect(fs.existsSync(configPath(env))).toBe(false);
	});

	test("it should reject a local directory as a source when the path points to a directory because a directory cannot be read as a registry file", async () => {
		const dir = path.join(root, "some-dir");
		fs.mkdirSync(dir);
		await expect(configSetCommand(dir, env)).rejects.toThrow(
			`Registry path "${dir}" points to ${dir}, which is not a file.`,
		);
		expect(fs.existsSync(configPath(env))).toBe(false);
	});

	test("it should reject a symlinked local path when the source resolves to a link because a symlink could silently point at an unexpected file", async () => {
		const target = path.join(root, "registry.json");
		fs.writeFileSync(target, "{}");
		const link = path.join(root, "link.json");
		fs.symlinkSync(target, link, "file");

		await expect(configSetCommand(link, env)).rejects.toThrow(
			/which is a symbolic link\./,
		);
		expect(fs.existsSync(configPath(env))).toBe(false);
	});
});

describe("configGetCommand", () => {
	let root: string;
	let env: NodeJS.ProcessEnv;
	let printed: string[];

	beforeEach(() => {
		({ root, env } = makeIsolatedEnv());
		printed = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			printed.push(args.map((arg) => String(arg)).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("it should print the saved registry source when a registry is saved because the user wants to see the effective configured source", async () => {
		await writeConfig({ registry: "https://saved.example.com/r.json" }, env);

		await configGetCommand(env);

		const output = printed.join("\n");
		expect(output).toContain("registry:    https://saved.example.com/r.json");
		expect(output).toContain(configPath(env));
		expect(output).not.toContain("(not set)");
	});

	test("it should print `(not set)` and a `yoinker configure set` hint when no source is saved", async () => {
		await configGetCommand(env);

		const output = printed.join("\n");
		expect(output).toContain("registry:    (not set)");
		expect(output).toContain("yoinker configure set");
		expect(output).toContain(configPath(env));
	});
});

describe("configUnsetCommand", () => {
	let root: string;
	let env: NodeJS.ProcessEnv;
	let printed: string[];

	beforeEach(() => {
		({ root, env } = makeIsolatedEnv());
		printed = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			printed.push(args.map((arg) => String(arg)).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("it should clear the saved registry, return true, and print `(not set)` with a hint when a registry was saved because unsetting leaves no source configured", async () => {
		await writeConfig({ registry: "https://saved.example.com/r.json" }, env);

		await expect(configUnsetCommand(env)).resolves.toBe(true);

		expect(fs.existsSync(configPath(env))).toBe(false);
		const output = printed.join("\n");
		expect(output).toContain("registry:    (not set)");
		expect(output).toContain("yoinker configure set");
	});

	test("it should return false and print `(not set)` with a hint when nothing was saved because there is no registry to clear", async () => {
		await expect(configUnsetCommand(env)).resolves.toBe(false);
		expect(fs.existsSync(configPath(env))).toBe(false);
		const output = printed.join("\n");
		expect(output).toContain("registry:    (not set)");
		expect(output).toContain("yoinker configure set");
	});
});
