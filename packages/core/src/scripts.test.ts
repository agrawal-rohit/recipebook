import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { RegistryConditionKind } from "./condition-kind";
import type { Registry } from "./schema";
import {
	assertIntegrityMatch,
	assertScriptsAllowed,
	classifyRegistryTrust,
	collectRegistryArtifactUris,
	createRejectedScriptExecutor,
	createScriptExecutor,
	type DeclaredScriptUris,
	loadSandboxedModule,
	RegistryTrust,
	sandboxRunnerPath,
	sha256Integrity,
	verifyItemIntegrity,
	verifyScriptIntegrity,
} from "./scripts";

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheetos-scripts-test-"));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Real runner entry for sandbox child spawns. `sandboxRunnerPath()` prefers the
 * compiled `dist/scripts.js`, but falls back to this TS source file under vitest,
 * which a plain `node` child cannot execute. Bundle the actual source runner with
 * esbuild (the same compiler production uses for registry scripts) so the e2e
 * spawns exercise the current runner code in a self-contained artifact.
 */
let runnerDir: string;
let bundledRunnerPath: string;

beforeAll(async () => {
	runnerDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheetos-runner-bundle-"));
	bundledRunnerPath = path.join(runnerDir, "scripts.cjs");
	await esbuild.build({
		entryPoints: [path.resolve(__dirname, "./scripts.ts")],
		bundle: true,
		platform: "node",
		format: "cjs",
		outfile: bundledRunnerPath,
		logLevel: "silent",
	});
});

afterAll(() => {
	fs.rmSync(runnerDir, { recursive: true, force: true });
});

describe("sha256Integrity", () => {
	test("it should produce an SRI-style sha256 digest for string content because integrity maps key digests by script URI", () => {
		expect(sha256Integrity("hello")).toBe(
			"sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
		);
	});

	test("it should hash Buffer and equivalent string content identically because compiled scripts are read as buffers", () => {
		expect(sha256Integrity(Buffer.from("hello"))).toBe(
			sha256Integrity("hello"),
		);
	});
});

describe("assertIntegrityMatch", () => {
	test("it should accept content whose digest equals the expected value because matching content is trustworthy", () => {
		expect(() =>
			assertIntegrityMatch("hello", sha256Integrity("hello"), "script r/a.js"),
		).not.toThrow();
	});

	test("it should fail closed when no digest is declared because unverified content must never load", () => {
		expect(() =>
			assertIntegrityMatch("hello", undefined, "script r/a.js"),
		).toThrowError(/Missing integrity digest for script r\/a\.js\./);
		expect(() =>
			assertIntegrityMatch("hello", "  ", "script r/a.js"),
		).toThrowError(/Missing integrity digest/);
	});

	test("it should reject digests without the sha256 prefix because only SRI-style digests are interpretable", () => {
		expect(() =>
			assertIntegrityMatch("hello", "deadbeef", "script r/a.js"),
		).toThrowError(
			"Invalid integrity digest for script r/a.js: expected sha256-<base64>.",
		);
	});

	test("it should reject content whose digest differs from the expected value because a mismatch means the registry was tampered with", () => {
		expect(() =>
			assertIntegrityMatch(
				"tampered",
				sha256Integrity("hello"),
				"script r/a.js",
			),
		).toThrowError(
			"Integrity check failed for script r/a.js: content does not match the registry digest.",
		);
	});
});

describe("verifyScriptIntegrity / verifyItemIntegrity", () => {
	test("it should verify a script digest looked up by its own URI because integrity maps are keyed by catalog URI", () => {
		const map = { "r/a.js": sha256Integrity("script bytes") };
		expect(() =>
			verifyScriptIntegrity(map, "r/a.js", "script bytes"),
		).not.toThrow();
		expect(() => verifyScriptIntegrity(map, "r/a.js", "other")).toThrowError(
			/Integrity check failed for script r\/a\.js/,
		);
	});

	test("it should verify an item digest looked up by its own source URI because compiled items are integrity-checked before install", () => {
		const map = { "r/button.json": sha256Integrity("{}") };
		expect(() => verifyItemIntegrity(map, "r/button.json", "{}")).not.toThrow();
		expect(() =>
			verifyItemIntegrity(undefined, "r/button.json", "{}"),
		).toThrowError(/Missing integrity digest for item r\/button\.json/);
		expect(() => verifyItemIntegrity({}, "r/button.json", "{}")).toThrowError(
			/Missing integrity digest for item r\/button\.json/,
		);
	});
});

describe("classifyRegistryTrust", () => {
	test("it should classify https index locations as remote because remote registries never execute scripts", () => {
		expect(classifyRegistryTrust("https://example.com/registry.json")).toBe(
			RegistryTrust.REMOTE,
		);
	});

	test("it should classify absolute local paths as local because local registries run scripts in the sandbox", () => {
		expect(classifyRegistryTrust("/registry/registry.json")).toBe(
			RegistryTrust.LOCAL,
		);
	});

	test("it should reject relative index locations because trust classification requires an unambiguous source", () => {
		expect(() => classifyRegistryTrust("registry.json")).toThrowError(
			"Registry index location must be an absolute path or HTTPS URL.",
		);
	});
});

describe("assertScriptsAllowed", () => {
	test("it should refuse mutation hooks and skip infer handlers for remote registries because remote scripts cannot be trusted to execute", async () => {
		const scripts: DeclaredScriptUris = {
			infer: ["r/_handlers/x.handler.js"],
			mutation: [],
		};
		await expect(
			assertScriptsAllowed(RegistryTrust.REMOTE, scripts),
		).resolves.toEqual({ allowInfer: false, allowMutation: false });
	});

	test("it should throw when a remote registry declares mutation hooks because installing would execute untrusted code", async () => {
		const scripts: DeclaredScriptUris = {
			infer: [],
			mutation: ["r/item.beforeWrite.0.js"],
		};
		await expect(
			assertScriptsAllowed(RegistryTrust.REMOTE, scripts),
		).rejects.toThrowError(
			"Registry scripts require a local registry. Remote HTTPS registries cannot execute custom scripts.",
		);
	});

	test("it should allow infer and mutation scripts for local registries when declared because local content is sandboxed", async () => {
		const scripts: DeclaredScriptUris = {
			infer: ["r/_handlers/x.handler.js"],
			mutation: ["r/item.beforeWrite.0.js"],
		};
		await expect(
			assertScriptsAllowed(RegistryTrust.LOCAL, scripts),
		).resolves.toEqual({ allowInfer: true, allowMutation: true });
	});
});

describe("createRejectedScriptExecutor", () => {
	test("it should reject every script load with an actionable message because a fail-closed executor must never fall back to loading", async () => {
		const executor = createRejectedScriptExecutor();
		await expect(
			executor.loadModule(
				"/registry.json",
				"r/a.js",
				(v): v is unknown => true,
				"unused",
			),
		).rejects.toThrowError(
			'Registry script "r/a.js" cannot run: scripts are not allowed for this install.',
		);
	});
});

describe("createScriptExecutor in-process mode", () => {
	test("it should load a verified CJS script export from a temp registry because local scripts load in-process before sandboxing is selected", async () => {
		const scriptPath = path.join(tempDir, "hook.js");
		fs.writeFileSync(
			scriptPath,
			"module.exports = async () => ({ removeFiles: ['x'] });",
		);
		const registryJson = path.join(tempDir, "registry.json");
		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: {
				"r/hook.js": sha256Integrity(fs.readFileSync(scriptPath)),
			},
		});

		const loaded = await executor.loadModule(
			registryJson,
			"r/hook.js",
			(v): v is () => Promise<unknown> => typeof v === "function",
			"must be a function",
		);
		expect(await loaded()).toEqual({ removeFiles: ["x"] });
	});

	test("it should verify integrity against the declared digest before loading because a tampered script file must never execute", async () => {
		const scriptPath = path.join(tempDir, "hook.js");
		fs.writeFileSync(scriptPath, "module.exports = () => 'safe';");
		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": sha256Integrity("original") },
		});

		await expect(
			executor.loadModule(
				path.join(tempDir, "registry.json"),
				"r/hook.js",
				(v): v is unknown => true,
				"unused",
			),
		).rejects.toThrowError(/Integrity check failed for script r\/hook\.js/);
	});

	test("it should throw the caller's error message when the export shape is invalid because callers own their export contracts", async () => {
		const scriptPath = path.join(tempDir, "not-a-function.js");
		fs.writeFileSync(scriptPath, "module.exports = { infer: 42 };");
		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: {
				"r/x.js": sha256Integrity(fs.readFileSync(scriptPath)),
			},
		});

		await expect(
			executor.loadModule(
				path.join(tempDir, "registry.json"),
				"r/x.js",
				(v): v is () => unknown => typeof v === "function",
				'Script at "r/x.js" must export a `beforeWrite` hook function.',
			),
		).rejects.toThrowError(
			'Script at "r/x.js" must export a `beforeWrite` hook function.',
		);
	});

	test("it should reject a locator that returns a relative path because script loads must be anchored to absolute files", async () => {
		const executor = createScriptExecutor({
			locateScriptPath: () => "r/hook.js",
			scriptIntegrity: { "r/hook.js": sha256Integrity("x") },
		});
		await expect(
			executor.loadModule(
				path.join(tempDir, "registry.json"),
				"r/hook.js",
				(v): v is unknown => true,
				"unused",
			),
		).rejects.toThrowError(
			'Script path for "r/hook.js" must be an absolute path.',
		);
	});
});

describe("createScriptExecutor sandbox mode guards", () => {
	test("it should require projectDir and runnerPath when sandbox mode is requested because the child process needs both to start", () => {
		expect(() =>
			createScriptExecutor({
				locateScriptPath: () => "/x.js",
				mode: "sandbox",
			}),
		).toThrowError(
			"Sandbox script execution requires projectDir and runnerPath.",
		);
	});

	test("it should reject relative projectDir and runnerPath because sandbox permission flags require absolute paths", () => {
		expect(() =>
			createScriptExecutor({
				locateScriptPath: () => "/x.js",
				mode: "sandbox",
				projectDir: "relative/project",
				runnerPath: "/runner.js",
			}),
		).toThrowError("Project directory must be an absolute path.");
		expect(() =>
			createScriptExecutor({
				locateScriptPath: () => "/x.js",
				mode: "sandbox",
				projectDir: "/project",
				runnerPath: "relative/runner.js",
			}),
		).toThrowError("Sandbox runner path must be an absolute path.");
	});
});

describe("sandboxed module loading (real child process)", () => {
	test("it should load a function export from a script file and invoke it because the sandbox must execute real local scripts", async () => {
		const scriptPath = path.join(tempDir, "hook.js");
		fs.writeFileSync(
			scriptPath,
			"module.exports = async (ctx) => ({ got: ctx.key });",
		);
		const loaded = (await loadSandboxedModule(
			scriptPath,
			tempDir,
			bundledRunnerPath,
		)) as (ctx: Record<string, unknown>) => Promise<unknown>;

		expect(await loaded({ key: "value" })).toEqual({ got: "value" });
	});

	test("it should load a condition-handler export and call its infer hook because condition handlers export objects, not functions", async () => {
		const scriptPath = path.join(tempDir, "handler.js");
		fs.writeFileSync(
			scriptPath,
			"module.exports = { infer: async (ctx) => ctx.conditions.previous };",
		);
		const loaded = (await loadSandboxedModule(
			scriptPath,
			tempDir,
			bundledRunnerPath,
		)) as { infer: (ctx: unknown) => Promise<unknown> };

		expect(await loaded.infer({ conditions: { previous: "yes" } })).toBe("yes");
	});

	test("it should reject an export that is neither a function nor a condition handler because the sandbox cannot proxy unknown shapes", async () => {
		const scriptPath = path.join(tempDir, "bad.js");
		fs.writeFileSync(scriptPath, "module.exports = { nope: true };");
		await expect(
			loadSandboxedModule(scriptPath, tempDir, bundledRunnerPath),
		).rejects.toThrowError(
			`Sandboxed script "${scriptPath}" must export a function or a condition handler with infer.`,
		);
	});
});

describe("sandboxRunnerPath", () => {
	test("it should return an absolute runner path because sandbox spawns require absolute entries", () => {
		expect(path.isAbsolute(sandboxRunnerPath())).toBe(true);
	});
});

describe("collectRegistryArtifactUris", () => {
	test("it should aggregate, dedupe, and sort every compiled script and item URI because install integrity and fetch plans depend on the complete set", () => {
		const registry: Registry = {
			conditions: {
				os: {
					label: "OS",
					kind: RegistryConditionKind.SELECT,
					handler: "r/_handlers/os.handler.js",
				},
			},
			types: { component: { label: "Components" } },
			items: {
				button: {
					title: "Button",
					description: "A button",
					type: "component",
					source: "r/button.json",
					beforeWrite: ["r/button.beforeWrite.0.js"],
					// Deliberate duplicate across phase lists and packs.
					afterInstall: [
						"r/button.afterInstall.0.js",
						"r/button.beforeWrite.0.js",
					],
					conditions: {
						own: {
							label: "Own",
							kind: RegistryConditionKind.BOOLEAN,
							handler: "r/_handlers/items/button/own.handler.js",
						},
					},
					packs: [
						{
							id: "ts",
							title: "TypeScript",
							source: "r/button/ts.json",
							beforeWrite: ["r/button/ts.beforeWrite.0.js"],
							afterInstall: ["r/button.beforeWrite.0.js"],
						},
					],
				},
			},
		};

		const { scriptUris, itemUris } = collectRegistryArtifactUris(registry);

		expect(scriptUris).toEqual(
			[
				"r/_handlers/os.handler.js",
				"r/button.beforeWrite.0.js",
				"r/button.afterInstall.0.js",
				"r/_handlers/items/button/own.handler.js",
				"r/button/ts.beforeWrite.0.js",
			].sort((left, right) => left.localeCompare(right)),
		);
		expect(itemUris).toEqual(
			["r/button.json", "r/button/ts.json"].sort((left, right) =>
				left.localeCompare(right),
			),
		);
	});

	test("it should return empty URI lists for a registry without handlers, hooks, or payloads because artifact hashing must tolerate empty registries", () => {
		const { scriptUris, itemUris } = collectRegistryArtifactUris({
			types: {},
			items: {},
		});

		expect(scriptUris).toEqual([]);
		expect(itemUris).toEqual([]);
	});
});
