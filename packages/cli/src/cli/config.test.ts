/** Mocked @yoinker/core readFileAsync seam — lets tests simulate a file vanishing (or failing) between lstat and read. */
const coreMocks = vi.hoisted(() => ({
	readFileAsync: vi.fn(),
	actualReadFileAsync: undefined as
		| ((path: string) => Promise<string>)
		| undefined,
}));
vi.mock("@yoinker/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@yoinker/core")>();
	coreMocks.actualReadFileAsync = actual.readFileAsync;
	return { ...actual, readFileAsync: coreMocks.readFileAsync };
});

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	configPath,
	readConfig,
	unsetRegistryConfig,
	writeConfig,
	type YoinkerConfig,
} from "./config";

/** Create a throwaway XDG config root and an env that points at it, so no test ever touches the real user config. */
function makeIsolatedEnv(): { root: string; env: NodeJS.ProcessEnv } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoinker-config-test-"));
	return { root, env: { XDG_CONFIG_HOME: root } };
}

function configFilePath(root: string): string {
	return path.join(root, "yoinker", "config.json");
}

/** Create a FIFO at the config path so the config guards must reject it as a special node. */
function makeFifo(filePath: string): void {
	const { status, stderr } = spawnSync("mkfifo", [filePath]);
	if (status !== 0)
		throw new Error(`mkfifo failed: ${stderr?.toString().trim()}`);
}

describe("configPath", () => {
	test("it should resolve the config path under XDG_CONFIG_HOME and append yoinker/config.json when the variable is set because users on XDG systems expect their config there", () => {
		const { root, env } = makeIsolatedEnv();
		try {
			expect(configPath(env)).toBe(configFilePath(root));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("it should trim surrounding whitespace from XDG_CONFIG_HOME when resolving the config path because a hand-edited env var commonly carries stray spaces", () => {
		const { root } = makeIsolatedEnv();
		try {
			expect(configPath({ XDG_CONFIG_HOME: `  ${root}\n` })).toBe(
				configFilePath(root),
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("it should fall back to the default base when XDG_CONFIG_HOME is whitespace-only because a whitespace-only value carries no usable directory", () => {
		expect(configPath({ XDG_CONFIG_HOME: "   " })).toBe(configPath({}));
	});

	test("it should resolve a relative XDG_CONFIG_HOME against the working directory when it is not absolute because relative env values are interpreted from where the process runs", () => {
		expect(configPath({ XDG_CONFIG_HOME: "relcfg" })).toBe(
			path.resolve(process.cwd(), "relcfg", "yoinker", "config.json"),
		);
	});

	test("it should default to ~/.config/yoinker/config.json when XDG_CONFIG_HOME is unset because that is the conventional location on systems without XDG", () => {
		expect(configPath({})).toBe(
			path.join(os.homedir(), ".config", "yoinker", "config.json"),
		);
	});
});

describe("readConfig", () => {
	let root: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(() => {
		({ root, env } = makeIsolatedEnv());
		coreMocks.readFileAsync.mockImplementation(
			coreMocks.actualReadFileAsync as (path: string) => Promise<string>,
		);
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("it should return an empty config and create no directory when the config file does not exist because a first run must not leave stray directories behind", async () => {
		await expect(readConfig(env)).resolves.toEqual({});
		expect(fs.existsSync(path.dirname(configFilePath(root)))).toBe(false);
	});

	test("it should parse a valid config file when reading because a well-formed config must load unchanged", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		fs.writeFileSync(
			configFilePath(root),
			'{\n\t"registry": "https://example.com/registry.json"\n}\n',
		);
		await expect(readConfig(env)).resolves.toEqual({
			registry: "https://example.com/registry.json",
		});
	});

	test("it should trim the stored registry value when parsing because saved whitespace must not leak into the effective registry URL", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		fs.writeFileSync(
			configFilePath(root),
			JSON.stringify({ registry: "  https://example.com/registry.json  " }),
		);
		await expect(readConfig(env)).resolves.toEqual({
			registry: "https://example.com/registry.json",
		});
	});

	test("it should read an empty JSON object back as an empty config when reading because an empty config is valid and must round-trip", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		fs.writeFileSync(configFilePath(root), "{}\n");
		await expect(readConfig(env)).resolves.toEqual({});
	});

	test.each([
		"null",
		"42",
		'"a string"',
		"[]",
		"[1, 2]",
	])("it should reject a root `%s` as a non-object when reading because the config root must be a JSON object", async (raw) => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		fs.writeFileSync(configFilePath(root), raw);
		await expect(readConfig(env)).rejects.toThrow(
			/Malformed yoinker config at .*config\.json: Config root must be a JSON object\./,
		);
	});

	test("it should wrap invalid JSON with the file path and remediation hint when reading because the user needs to know where and how to fix the file", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		fs.writeFileSync(configFilePath(root), "{ not json");
		await expect(readConfig(env)).rejects.toThrow(
			/^Malformed yoinker config at .*config\.json: .+\. Fix or delete the file, then retry\.$/,
		);
	});

	test("it should reject an unknown key when reading because an unknown key signals a newer or corrupted config", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		fs.writeFileSync(configFilePath(root), '{"telemetry": true}');
		await expect(readConfig(env)).rejects.toThrow(
			/Malformed yoinker config at .*config\.json: Unknown config key "telemetry"\./,
		);
	});

	test.each([
		["number", '{"registry": 123}'],
		["object", '{"registry": {}}'],
		["empty string", '{"registry": ""}'],
		["whitespace-only string", '{"registry": "   "}'],
	])("it should reject a `%s` registry value when reading because the registry must be a non-empty string URL or file path", async (_label, raw) => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		fs.writeFileSync(configFilePath(root), raw);
		await expect(readConfig(env)).rejects.toThrow(
			/Malformed yoinker config at .*config\.json: "registry" must be a non-empty string URL or file path\./,
		);
	});

	test("it should reject a config file over 65 536 bytes before parsing when reading because oversized files are likely corrupt or malicious", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		fs.writeFileSync(
			configFilePath(root),
			`{"registry":"${"a".repeat(65_537)}"}`,
		);
		await expect(readConfig(env)).rejects.toThrow(
			/Cannot read yoinker config at .*config\.json: file is too large\./,
		);
	});

	test("it should treat a config file that vanishes after the lstat as absent because the file can be deleted between the guard and the read", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		fs.writeFileSync(configFilePath(root), "{}");
		coreMocks.readFileAsync.mockRejectedValueOnce(
			Object.assign(new Error("vanished"), { code: "ENOENT" }),
		);

		await expect(readConfig(env)).resolves.toEqual({});
	});

	test("it should rethrow a non-missing read error because a vanished file is the only expected failure", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		fs.writeFileSync(configFilePath(root), "{}");
		const denial = Object.assign(new Error("denied"), { code: "EACCES" });
		coreMocks.readFileAsync.mockRejectedValueOnce(denial);

		await expect(readConfig(env)).rejects.toMatchObject({ code: "EACCES" });
	});

	test("it should check the size cap before JSON parsing because a size test after parsing would misreport a malformed-config error", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		// Invalid JSON that is over the cap: a size check after parsing would report
		// a malformed-config error instead of the size error.
		fs.writeFileSync(configFilePath(root), "{".repeat(65_537));
		await expect(readConfig(env)).rejects.toThrow("file is too large");
	});

	test("it should accept a config file of exactly 65 536 bytes when reading because the cap is inclusive of the maximum safe size", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		const frame = '{"registry":""}';
		const padding = "a".repeat(65_536 - Buffer.byteLength(frame));
		fs.writeFileSync(configFilePath(root), `{"registry":"${padding}"}`);
		const config = await readConfig(env);
		expect(config.registry).toBe(padding);
	});

	test("it should stringify a non-Error parse failure into the malformed-config message when reading because whatever JSON.parse throws must still carry the remediation hint", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		fs.writeFileSync(configFilePath(root), "{ not json");
		const parseSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
			throw "thrown string";
		});
		try {
			await expect(readConfig(env)).rejects.toThrow(
				/Malformed yoinker config at .*config\.json: thrown string\. Fix or delete the file, then retry\./,
			);
		} finally {
			parseSpy.mockRestore();
		}
	});

	test("it should refuse to read a symlinked config file when the path resolves to a link because a symlinked config could be an attack vector", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		const target = path.join(root, "real.json");
		fs.writeFileSync(
			target,
			'{"registry":"https://example.com/registry.json"}',
		);
		fs.symlinkSync(target, configFilePath(root), "file");
		await expect(readConfig(env)).rejects.toThrow(
			/Cannot read yoinker config at .*config\.json: file is a symbolic link\./,
		);
	});

	test("it should refuse to read when the config path is a directory because a directory holds no config file", async () => {
		fs.mkdirSync(configFilePath(root), { recursive: true });
		await expect(readConfig(env)).rejects.toThrow(
			/Cannot read yoinker config at .*config\.json: path is a directory\./,
		);
	});

	test.skipIf(process.platform === "win32")(
		"it should refuse to read a FIFO at the config path because a special node is neither a file nor a directory",
		async () => {
			fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
			makeFifo(configFilePath(root));
			// The guard short-circuits before any blocking read of the FIFO.
			await expect(readConfig(env)).rejects.toThrow(
				/Cannot read yoinker config at .*config\.json: path is neither a file nor a directory\./,
			);
		},
	);
});

describe("writeConfig", () => {
	let root: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(() => {
		({ root, env } = makeIsolatedEnv());
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("it should create the yoinker directory with mode 0o700 when writing because the config directory must be private to the user", async () => {
		await writeConfig({ registry: "https://example.com/registry.json" }, env);
		const dirMode =
			fs.statSync(path.dirname(configFilePath(root))).mode & 0o777;
		expect(dirMode).toBe(0o700);
	});

	test("it should create the config file with mode 0o600 when writing because the config may hold private registry details", async () => {
		await writeConfig({ registry: "https://example.com/registry.json" }, env);
		const fileMode = fs.statSync(configFilePath(root)).mode & 0o777;
		expect(fileMode).toBe(0o600);
	});

	test("it should write an empty config that reads back as empty when writing because an empty config is valid and must round-trip", async () => {
		await writeConfig({}, env);
		await expect(readConfig(env)).resolves.toEqual({});
	});

	test("it should trim the registry value before persisting when writing because saved whitespace would break the effective registry URL", async () => {
		await writeConfig(
			{ registry: "  https://example.com/registry.json  " },
			env,
		);
		await expect(readConfig(env)).resolves.toEqual({
			registry: "https://example.com/registry.json",
		});
	});

	test("it should silently drop unknown keys instead of persisting them when writing because persisting them would make readConfig reject the file", async () => {
		await writeConfig(
			{
				registry: "https://example.com/registry.json",
				telemetry: true,
			} as YoinkerConfig,
			env,
		);
		// A persisted unknown key would make readConfig reject the file.
		await expect(readConfig(env)).resolves.toEqual({
			registry: "https://example.com/registry.json",
		});
		expect(fs.readFileSync(configFilePath(root), "utf8")).toBe(
			'{\n\t"registry": "https://example.com/registry.json"\n}\n',
		);
	});

	test.each([
		["non-string", { registry: 123 }],
		["empty string", { registry: "" }],
		["whitespace-only string", { registry: "   " }],
	])("it should reject a `%s` registry and write nothing when writing because the registry must be a non-empty string URL or file path", async (_label, bad) => {
		await expect(writeConfig(bad as YoinkerConfig, env)).rejects.toThrow(
			'"registry" must be a non-empty string URL or file path.',
		);
		expect(fs.existsSync(configFilePath(root))).toBe(false);
	});

	test("it should write a config that reads back unchanged and replace it on rewrite because the save must round-trip exactly", async () => {
		await writeConfig({ registry: "https://first.example.com/r.json" }, env);
		await expect(readConfig(env)).resolves.toEqual({
			registry: "https://first.example.com/r.json",
		});

		await writeConfig({ registry: "https://second.example.com/r.json" }, env);
		await expect(readConfig(env)).resolves.toEqual({
			registry: "https://second.example.com/r.json",
		});
	});

	test("it should refuse to overwrite a symlink and leave its target untouched when writing because overwriting could redirect writes to a file we do not own", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		const target = path.join(root, "real.json");
		fs.writeFileSync(target, "keep me");
		fs.symlinkSync(target, configFilePath(root), "file");

		await expect(
			writeConfig({ registry: "https://example.com/registry.json" }, env),
		).rejects.toThrow(
			/Cannot write yoinker config at .*config\.json: file is a symbolic link\./,
		);
		expect(fs.readFileSync(target, "utf8")).toBe("keep me");
	});

	test("it should refuse to write through a dangling symlink when writing because a dangling link could be re-pointed to an attacker-chosen target", async () => {
		fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
		fs.symlinkSync(
			path.join(root, "never-created"),
			configFilePath(root),
			"file",
		);

		await expect(
			writeConfig({ registry: "https://example.com/registry.json" }, env),
		).rejects.toThrow(/symbolic link/);
		expect(fs.existsSync(configFilePath(root))).toBe(false);
	});

	test("it should refuse to write when the config path is a directory because a directory cannot be replaced by a config file", async () => {
		fs.mkdirSync(configFilePath(root), { recursive: true });
		await expect(
			writeConfig({ registry: "https://example.com/registry.json" }, env),
		).rejects.toThrow(
			/Cannot write yoinker config at .*config\.json: path is a directory\./,
		);
	});

	test.skipIf(process.platform === "win32")(
		"it should refuse to write when the config path is a FIFO because a special node cannot be replaced by an empty config file",
		async () => {
			fs.mkdirSync(path.dirname(configFilePath(root)), { recursive: true });
			makeFifo(configFilePath(root));
			await expect(
				writeConfig({ registry: "https://example.com/registry.json" }, env),
			).rejects.toThrow(
				/Cannot write yoinker config at .*\.json: path is neither a file nor a directory\./,
			);
		},
	);
});

describe("unsetRegistryConfig", () => {
	let root: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(() => {
		({ root, env } = makeIsolatedEnv());
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("it should remove the saved registry and report true when a registry was saved because the user asked to clear it", async () => {
		await writeConfig({ registry: "https://example.com/registry.json" }, env);
		await expect(unsetRegistryConfig(env)).resolves.toBe(true);
		expect(fs.existsSync(configFilePath(root))).toBe(false);
		await expect(readConfig(env)).resolves.toEqual({});
	});

	test("it should report false and create nothing when no config exists because there is nothing to clear", async () => {
		await expect(unsetRegistryConfig(env)).resolves.toBe(false);
		expect(fs.existsSync(configFilePath(root))).toBe(false);
		expect(fs.existsSync(path.dirname(configFilePath(root)))).toBe(false);
	});

	test("it should report false and keep the config file when nothing is saved because an empty config is still a valid file that should remain", async () => {
		await writeConfig({}, env);
		await expect(unsetRegistryConfig(env)).resolves.toBe(false);
		expect(fs.existsSync(configFilePath(root))).toBe(true);
	});

	test("it should report false on a second unset after clearing because repeatedly unsetting a missing registry must stay a no-op", async () => {
		await writeConfig({ registry: "https://example.com/registry.json" }, env);
		await expect(unsetRegistryConfig(env)).resolves.toBe(true);
		await expect(unsetRegistryConfig(env)).resolves.toBe(false);
	});
});
