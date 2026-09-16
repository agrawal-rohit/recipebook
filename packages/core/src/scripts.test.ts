import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unwrapModuleExport } from "./cjs-export";
import { RegistryConditionKind } from "./condition-kind";
import { NpmPackageManager } from "./packages";
import { collectDeclaredScriptUris } from "./plan";
import {
	assertIntegrityMatch,
	assertScriptsAllowed,
	classifyRegistryTrust,
	collectRegistryArtifactUris,
	createRejectedScriptExecutor,
	createScriptExecutor,
	INTEGRITY_PREFIX,
	RegistryTrust,
	sandboxRunnerPath,
	sha256Integrity,
	verifyItemIntegrity,
	verifyScriptIntegrity,
} from "./scripts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Create a temporary directory for script fixtures.
 * @returns Absolute temp directory path.
 */
function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pebbles-security-"));
	tempDirs.push(dir);
	return dir;
}

describe("scripts (trust and integrity)", () => {
	it("classifies bundled, local, and remote registry trust", () => {
		expect(
			classifyRegistryTrust("/app/registry.json", "/app/registry.json"),
		).toBe(RegistryTrust.BUNDLED);
		expect(
			classifyRegistryTrust("/other/registry.json", "/app/registry.json"),
		).toBe(RegistryTrust.LOCAL);
		expect(
			classifyRegistryTrust(
				"https://example.com/registry.json",
				"/app/registry.json",
			),
		).toBe(RegistryTrust.REMOTE);
	});

	it("rejects relative registry index and bundled paths", () => {
		expect(() =>
			classifyRegistryTrust("registry.json", "/app/registry.json"),
		).toThrow("Registry index location must be an absolute path or HTTPS URL.");
		expect(() =>
			classifyRegistryTrust("/app/registry.json", "bundled.json"),
		).toThrow("Bundled registry path must be an absolute path.");
	});

	it("allows bundled scripts without prompting", async () => {
		await expect(
			assertScriptsAllowed(RegistryTrust.BUNDLED, {
				infer: [],
				mutation: ["r/item.beforeWrite.0.js"],
			}),
		).resolves.toEqual({ allowInfer: false, allowMutation: true });
	});

	it("allows local scripts and fails remote mutation hooks", async () => {
		await expect(
			assertScriptsAllowed(RegistryTrust.LOCAL, {
				infer: [],
				mutation: ["r/item.beforeWrite.0.js"],
			}),
		).resolves.toEqual({ allowInfer: false, allowMutation: true });

		await expect(
			assertScriptsAllowed(RegistryTrust.REMOTE, {
				infer: [],
				mutation: ["r/item.beforeWrite.0.js"],
			}),
		).rejects.toThrow("Remote HTTPS registries cannot execute custom scripts");
	});

	it("skips infer handlers on remote registries without throwing", async () => {
		await expect(
			assertScriptsAllowed(RegistryTrust.REMOTE, {
				infer: ["r/_handlers/language.handler.js"],
				mutation: [],
			}),
		).resolves.toEqual({ allowInfer: false, allowMutation: false });
	});

	it("hashes and verifies integrity digests", () => {
		const digest = sha256Integrity("hello");
		expect(digest.startsWith(INTEGRITY_PREFIX)).toBe(true);
		expect(() =>
			assertIntegrityMatch("hello", digest, "fixture"),
		).not.toThrow();
		expect(() => assertIntegrityMatch("other", digest, "fixture")).toThrow(
			"does not match",
		);
		expect(() =>
			assertIntegrityMatch("hello", "md5-not-sha256", "fixture"),
		).toThrow(
			`Invalid integrity digest for fixture: expected ${INTEGRITY_PREFIX}<base64>.`,
		);
		expect(() => assertIntegrityMatch("hello", undefined, "fixture")).toThrow(
			"Missing integrity digest",
		);

		verifyScriptIntegrity({ "r/a.js": digest }, "r/a.js", "hello");
		verifyItemIntegrity({ "r/a.json": digest }, "r/a.json", "hello");
	});

	it("does not treat inherited integrity map keys as digests", () => {
		const digest = sha256Integrity("hello");
		const inherited = Object.create({ "r/a.js": digest }) as Record<
			string,
			string
		>;
		expect(() => verifyScriptIntegrity(inherited, "r/a.js", "hello")).toThrow(
			"Missing integrity digest for script r/a.js",
		);
		expect(() => verifyScriptIntegrity({}, "toString", "hello")).toThrow(
			"Missing integrity digest for script toString",
		);
		expect(() => verifyItemIntegrity({}, "__proto__", "hello")).toThrow(
			"Missing integrity digest for item __proto__",
		);
	});

	it("collects condition handlers and install hooks for selected items", () => {
		const registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				language: {
					kind: RegistryConditionKind.SELECT,
					label: "Language",
					handler: "r/_handlers/language.handler.js",
					values: [{ value: "typescript", label: "TypeScript" }],
				},
			},
			items: {
				license: {
					title: "License",
					description: "SPDX",
					type: "configuration",
					requires: ["language"],
					source: "r/license.json",
					beforeWrite: ["r/license.beforeWrite.0.js"],
					afterInstall: ["r/license.afterInstall.0.js"],
					conditions: {
						owner: {
							kind: RegistryConditionKind.TEXT,
							label: "Owner",
							handler: "r/license.owner.handler.js",
						},
					},
					packs: [
						{
							id: "mit",
							title: "MIT",
							source: "r/license/mit.json",
							beforeWrite: ["r/license/mit.beforeWrite.0.js"],
							afterInstall: ["r/license/mit.afterInstall.0.js"],
						},
					],
				},
			},
		};
		const uris = collectDeclaredScriptUris(registry, [
			"license@mit",
			"missing",
		]);

		expect(uris).toEqual({
			infer: ["r/_handlers/language.handler.js", "r/license.owner.handler.js"],
			mutation: [
				"r/license.afterInstall.0.js",
				"r/license.beforeWrite.0.js",
				"r/license/mit.afterInstall.0.js",
				"r/license/mit.beforeWrite.0.js",
			],
		});
		expect(collectRegistryArtifactUris(registry)).toEqual({
			scriptUris: [
				"r/_handlers/language.handler.js",
				"r/license.afterInstall.0.js",
				"r/license.beforeWrite.0.js",
				"r/license.owner.handler.js",
				"r/license/mit.afterInstall.0.js",
				"r/license/mit.beforeWrite.0.js",
			],
			itemUris: ["r/license.json", "r/license/mit.json"],
		});
	});

	it("omits pack mutation hooks ruled out by the selected package manager", () => {
		const registry = {
			types: { configuration: { label: "Configurations" } },
			items: {
				setup: {
					title: "Setup",
					description: "Setup",
					type: "workflow",
					packs: [
						{
							id: "pnpm",
							title: "pnpm",
							source: "r/setup/pnpm.json",
							when: { packageManager: "pnpm" },
							beforeWrite: ["r/setup/pnpm.beforeWrite.0.js"],
						},
						{
							id: "npm",
							title: "npm",
							source: "r/setup/npm.json",
							when: { packageManager: "npm" },
							beforeWrite: ["r/setup/npm.beforeWrite.0.js"],
						},
					],
				},
			},
		};

		expect(
			collectDeclaredScriptUris(registry, ["setup"], {
				packageManager: NpmPackageManager.PNPM,
			}),
		).toEqual({
			infer: [],
			mutation: ["r/setup/pnpm.beforeWrite.0.js"],
		});
	});

	it("includes shared handlers from still-possible pack when keys", () => {
		const registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				language: {
					kind: RegistryConditionKind.SELECT,
					label: "Language",
					handler: "r/_handlers/language.handler.js",
					values: [{ value: "typescript", label: "TypeScript" }],
				},
			},
			items: {
				testing: {
					title: "Testing",
					description: "Testing",
					type: "configuration",
					packs: [
						{
							id: "typescript",
							title: "TypeScript",
							source: "r/testing/typescript.json",
							when: { language: "typescript" },
						},
					],
				},
			},
		};

		expect(collectDeclaredScriptUris(registry, ["testing"])).toEqual({
			infer: ["r/_handlers/language.handler.js"],
			mutation: [],
		});
	});

	it("skips shared conditions without handlers and ruled-out when clauses", () => {
		const registry = {
			types: { configuration: { label: "Configurations" } },
			conditions: {
				owner: {
					kind: RegistryConditionKind.TEXT,
					label: "Owner",
				},
				language: {
					kind: RegistryConditionKind.SELECT,
					label: "Language",
					handler: "r/_handlers/language.handler.js",
					values: [{ value: "typescript", label: "TypeScript" }],
					when: { framework: "next" },
				},
			},
			items: {
				setup: {
					title: "Setup",
					description: "Setup",
					type: "configuration",
					requires: ["owner", "language"],
					source: "r/setup.json",
				},
			},
		};

		expect(
			collectDeclaredScriptUris(registry, ["setup"], {
				context: { framework: "django" },
			}),
		).toEqual({ infer: [], mutation: [] });
	});

	it("rejects every load through the fail-closed executor", async () => {
		const executor = createRejectedScriptExecutor();
		await expect(
			executor.loadModule(
				"/registry.json",
				"r/item.beforeWrite.0.js",
				(value: unknown): value is unknown => true,
				"unused",
			),
		).rejects.toThrow("cannot run");
	});

	it("unwraps a default export when present", () => {
		const fn = () => "ok";
		expect(unwrapModuleExport({ default: fn })).toBe(fn);
		expect(unwrapModuleExport(fn)).toBe(fn);
	});

	it("loads modules through the in-process script executor with integrity checks", async () => {
		const dir = makeTempDir();
		const scriptPath = path.join(dir, "hook.js");
		fs.writeFileSync(
			scriptPath,
			'module.exports = async function beforeWrite() { return { bindings: { ok: "1" } }; };\n',
		);
		const digest = sha256Integrity(fs.readFileSync(scriptPath));
		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
		});
		const hook = await executor.loadModule(
			path.join(dir, "registry.json"),
			"r/hook.js",
			(value): value is (ctx: unknown) => Promise<unknown> =>
				typeof value === "function",
			"expected function",
		);
		await expect(hook({})).resolves.toEqual({ bindings: { ok: "1" } });
	});

	it("rejects in-process exports that fail the shape predicate", async () => {
		const dir = makeTempDir();
		const scriptPath = path.join(dir, "hook.js");
		fs.writeFileSync(scriptPath, "module.exports = { notAFunction: true };\n");
		const digest = sha256Integrity(fs.readFileSync(scriptPath));
		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "in-process",
		});
		await expect(
			executor.loadModule(
				path.join(dir, "registry.json"),
				"r/hook.js",
				(value): value is (ctx: unknown) => Promise<unknown> =>
					typeof value === "function",
				"expected function",
			),
		).rejects.toThrow("expected function");
	});

	it("rejects script loads when integrity is omitted", async () => {
		const dir = makeTempDir();
		const scriptPath = path.join(dir, "hook.js");
		fs.writeFileSync(
			scriptPath,
			"module.exports = async function beforeWrite() {};\n",
		);
		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			mode: "in-process",
		});

		await expect(
			executor.loadModule(
				path.join(dir, "registry.json"),
				"r/hook.js",
				(value): value is unknown => true,
				"unused",
			),
		).rejects.toThrow("Missing integrity digest for script r/hook.js");
	});

	it("rejects in-process loads when the resolver returns a relative path", async () => {
		const executor = createScriptExecutor({
			locateScriptPath: () => "hook.js",
			scriptIntegrity: { "r/hook.js": sha256Integrity("unused") },
			mode: "in-process",
		});
		await expect(
			executor.loadModule(
				"/registry.json",
				"r/hook.js",
				(value): value is unknown => true,
				"unused",
			),
		).rejects.toThrow('Script path for "r/hook.js" must be an absolute path.');
	});

	it("rejects sandbox executors without absolute projectDir and runnerPath", () => {
		expect(() =>
			createScriptExecutor({
				locateScriptPath: () => "/abs/hook.js",
				mode: "sandbox",
			}),
		).toThrow("Sandbox script execution requires projectDir and runnerPath.");
		expect(() =>
			createScriptExecutor({
				locateScriptPath: () => "/abs/hook.js",
				mode: "sandbox",
				projectDir: "relative",
				runnerPath: "/abs/runner.js",
			}),
		).toThrow("Project directory must be an absolute path.");
		expect(() =>
			createScriptExecutor({
				locateScriptPath: () => "/abs/hook.js",
				mode: "sandbox",
				projectDir: "/abs/project",
				runnerPath: "runner.js",
			}),
		).toThrow("Sandbox runner path must be an absolute path.");
	});
});

/**
 * Absolute path to the compiled sandbox runner used by child processes.
 * @returns Absolute path to `dist/scripts.js`.
 */
function compiledRunnerPath(): string {
	return path.join(__dirname, "..", "dist", "scripts.js");
}

/**
 * Write a CommonJS hook script and return its absolute path plus integrity digest.
 * @param dir - Directory that owns the script.
 * @param source - CommonJS module source.
 * @returns Absolute script path and sha256 integrity digest.
 */
function writeHook(
	dir: string,
	source: string,
): { scriptPath: string; digest: string } {
	const scriptPath = path.join(dir, "hook.js");
	fs.writeFileSync(scriptPath, source, "utf8");
	return { scriptPath, digest: sha256Integrity(fs.readFileSync(scriptPath)) };
}

describe("scripts (sandbox)", () => {
	it("blocks direct filesystem writes inside the permissioned child", async () => {
		const dir = makeTempDir();
		const projectDir = path.join(dir, "project");
		fs.mkdirSync(projectDir);
		const target = path.join(dir, "outside.txt");
		const { scriptPath, digest } = writeHook(
			dir,
			`
module.exports = async function beforeWrite() {
  require("node:fs").writeFileSync(${JSON.stringify(target)}, "pwned");
  return {};
};
`,
		);

		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "sandbox",
			projectDir,
			runnerPath: compiledRunnerPath(),
		});
		const hook = await executor.loadModule(
			path.join(dir, "registry.json"),
			"r/hook.js",
			(value): value is (ctx: unknown) => Promise<unknown> =>
				typeof value === "function",
			"expected function",
		);

		await expect(hook({ projectDir })).rejects.toThrow();
		expect(fs.existsSync(target)).toBe(false);
	}, 15_000);

	it("rejects malformed child IPC messages", async () => {
		const dir = makeTempDir();
		const projectDir = path.join(dir, "project");
		fs.mkdirSync(projectDir);
		const { scriptPath, digest } = writeHook(
			dir,
			`
module.exports = async function beforeWrite() {
  process.send?.({ type: "invalid" });
  return {};
};
`,
		);

		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "sandbox",
			projectDir,
			runnerPath: compiledRunnerPath(),
		});
		const hook = await executor.loadModule(
			path.join(dir, "registry.json"),
			"r/hook.js",
			(value): value is (ctx: unknown) => Promise<unknown> =>
				typeof value === "function",
			"expected function",
		);

		await expect(hook({ projectDir })).rejects.toThrow("invalid IPC message");
	}, 15_000);

	it("rejects child IPC messages with a non-string type", async () => {
		const dir = makeTempDir();
		const projectDir = path.join(dir, "project");
		fs.mkdirSync(projectDir);
		const { scriptPath, digest } = writeHook(
			dir,
			`
module.exports = async function beforeWrite() {
  process.send?.({ type: 1 });
  return {};
};
`,
		);

		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "sandbox",
			projectDir,
			runnerPath: compiledRunnerPath(),
		});
		const hook = await executor.loadModule(
			path.join(dir, "registry.json"),
			"r/hook.js",
			(value): value is (ctx: unknown) => Promise<unknown> =>
				typeof value === "function",
			"expected function",
		);

		await expect(hook({ projectDir })).rejects.toThrow("invalid IPC message");
	}, 15_000);

	it("cleans up when the sandbox child exits by signal", async () => {
		const dir = makeTempDir();
		const projectDir = path.join(dir, "project");
		fs.mkdirSync(projectDir);
		const { scriptPath, digest } = writeHook(
			dir,
			`
module.exports = async function beforeWrite() {
  process.kill(process.pid, "SIGTERM");
  await new Promise(() => {});
};
`,
		);

		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "sandbox",
			projectDir,
			runnerPath: compiledRunnerPath(),
		});
		const hook = await executor.loadModule(
			path.join(dir, "registry.json"),
			"r/hook.js",
			(value): value is (ctx: unknown) => Promise<unknown> =>
				typeof value === "function",
			"expected function",
		);

		await expect(hook({ projectDir })).rejects.toThrow("signal SIGTERM");
	}, 15_000);

	it("loads condition-handler exports through the sandbox", async () => {
		const dir = makeTempDir();
		const projectDir = path.join(dir, "project");
		fs.mkdirSync(projectDir);
		const { scriptPath, digest } = writeHook(
			dir,
			`
module.exports = {
  infer: async function infer() { return "typescript"; }
};
`,
		);

		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "sandbox",
			projectDir,
			runnerPath: compiledRunnerPath(),
		});
		const handler = await executor.loadModule(
			path.join(dir, "registry.json"),
			"r/hook.js",
			(value): value is { infer: (ctx: unknown) => Promise<unknown> } =>
				typeof value === "object" &&
				value !== null &&
				typeof (value as { infer?: unknown }).infer === "function",
			"expected condition handler",
		);

		await expect(handler.infer({ projectDir })).resolves.toBe("typescript");
	}, 15_000);

	it("rejects unknown sandbox export shapes", async () => {
		const dir = makeTempDir();
		const projectDir = path.join(dir, "project");
		fs.mkdirSync(projectDir);
		const { scriptPath, digest } = writeHook(
			dir,
			"module.exports = { notAHandler: true };\n",
		);

		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "sandbox",
			projectDir,
			runnerPath: compiledRunnerPath(),
		});

		await expect(
			executor.loadModule(
				path.join(dir, "registry.json"),
				"r/hook.js",
				(value): value is unknown => true,
				"unused",
			),
		).rejects.toThrow(
			"must export a function or a condition handler with infer",
		);
	}, 15_000);

	it("surfaces probe failures when the sandbox script cannot load", async () => {
		const dir = makeTempDir();
		const projectDir = path.join(dir, "project");
		fs.mkdirSync(projectDir);
		const { scriptPath, digest } = writeHook(
			dir,
			'throw new Error("cannot load hook");\n',
		);

		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "sandbox",
			projectDir,
			runnerPath: compiledRunnerPath(),
		});

		await expect(
			executor.loadModule(
				path.join(dir, "registry.json"),
				"r/hook.js",
				(value): value is unknown => true,
				"unused",
			),
		).rejects.toThrow("cannot load hook");
	}, 15_000);

	it("rejects unsafe handler context keys before calling the child", async () => {
		const dir = makeTempDir();
		const projectDir = path.join(dir, "project");
		fs.mkdirSync(projectDir);
		const { scriptPath, digest } = writeHook(
			dir,
			"module.exports = async function beforeWrite() { return {}; };\n",
		);

		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "sandbox",
			projectDir,
			runnerPath: compiledRunnerPath(),
		});
		const hook = await executor.loadModule(
			path.join(dir, "registry.json"),
			"r/hook.js",
			(value): value is (ctx: unknown) => Promise<unknown> =>
				typeof value === "function",
			"expected function",
		);

		await expect(hook({ projectDir, "": "bad" })).rejects.toThrow(
			'Handler context key "" is not allowed.',
		);
		const polluted: Record<string, unknown> = { projectDir };
		Object.defineProperty(polluted, "__proto__", {
			value: "bad",
			enumerable: true,
			configurable: true,
			writable: true,
		});
		await expect(hook(polluted)).rejects.toThrow(
			'Handler context key "__proto__" is not allowed.',
		);
	}, 15_000);

	it("serializes non-function context fields into the sandbox call", async () => {
		const dir = makeTempDir();
		const projectDir = path.join(dir, "project");
		fs.mkdirSync(projectDir);
		const { scriptPath, digest } = writeHook(
			dir,
			`
module.exports = async function beforeWrite(ctx) {
  return { bindings: { tag: String(ctx.tag), hasFn: String(typeof ctx.skip === "function") } };
};
`,
		);

		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "sandbox",
			projectDir,
			runnerPath: compiledRunnerPath(),
		});
		const hook = await executor.loadModule(
			path.join(dir, "registry.json"),
			"r/hook.js",
			(value): value is (ctx: unknown) => Promise<unknown> =>
				typeof value === "function",
			"expected function",
		);

		await expect(
			hook({ projectDir, tag: "ok", skip: () => "nope" }),
		).resolves.toEqual({
			bindings: { tag: "ok", hasFn: "false" },
		});
	}, 15_000);

	it("mediates ctx.isFile and ctx.isDirectory through the parent", async () => {
		const dir = makeTempDir();
		const projectDir = path.join(dir, "project");
		fs.mkdirSync(projectDir);
		fs.writeFileSync(path.join(projectDir, "package.json"), "{}\n", "utf8");
		fs.mkdirSync(path.join(projectDir, "src"));
		const { scriptPath, digest } = writeHook(
			dir,
			`
module.exports = async function beforeWrite(ctx) {
  return {
    bindings: {
      hasPkg: String(await ctx.isFile("package.json")),
      hasSrc: String(await ctx.isDirectory("src")),
    },
  };
};
`,
		);

		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "sandbox",
			projectDir,
			runnerPath: compiledRunnerPath(),
		});
		const hook = await executor.loadModule(
			path.join(dir, "registry.json"),
			"r/hook.js",
			(value): value is (ctx: unknown) => Promise<unknown> =>
				typeof value === "function",
			"expected function",
		);

		await expect(hook({ projectDir })).resolves.toEqual({
			bindings: { hasPkg: "true", hasSrc: "true" },
		});
	}, 15_000);

	it("allows ctx.readFile under the project and parent-mediated ctx.run", async () => {
		const dir = makeTempDir();
		const projectDir = path.join(dir, "project");
		fs.mkdirSync(projectDir);
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			'{"name":"demo"}\n',
			"utf8",
		);
		const { scriptPath, digest } = writeHook(
			dir,
			`
module.exports = async function beforeWrite(ctx) {
  const pkg = await ctx.readFile("package.json");
  const out = await ctx.run("printf ok");
  return { bindings: { pkg: pkg.trim(), out: out.trim() } };
};
`,
		);

		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "sandbox",
			projectDir,
			runnerPath: compiledRunnerPath(),
		});
		const hook = await executor.loadModule(
			path.join(dir, "registry.json"),
			"r/hook.js",
			(value): value is (ctx: unknown) => Promise<unknown> =>
				typeof value === "function",
			"expected function",
		);

		await expect(hook({ projectDir })).resolves.toEqual({
			bindings: { pkg: '{"name":"demo"}', out: "ok" },
		});
	}, 15_000);

	it("rejects path escapes via ctx.readFile", async () => {
		const dir = makeTempDir();
		const projectDir = path.join(dir, "project");
		fs.mkdirSync(projectDir);
		const { scriptPath, digest } = writeHook(
			dir,
			`
module.exports = async function beforeWrite(ctx) {
  return { bindings: { secret: await ctx.readFile("../.ssh/id_rsa") } };
};
`,
		);

		const executor = createScriptExecutor({
			locateScriptPath: () => scriptPath,
			scriptIntegrity: { "r/hook.js": digest },
			mode: "sandbox",
			projectDir,
			runnerPath: compiledRunnerPath(),
		});
		const hook = await executor.loadModule(
			path.join(dir, "registry.json"),
			"r/hook.js",
			(value): value is (ctx: unknown) => Promise<unknown> =>
				typeof value === "function",
			"expected function",
		);

		await expect(hook({ projectDir })).rejects.toThrow(
			"must be a relative path under the project directory",
		);
	}, 15_000);

	it("resolves sandboxRunnerPath to the compiled adjacent scripts.js when present", () => {
		const compiled = path.join(__dirname, "scripts.js");
		const spy = vi.spyOn(fs, "existsSync").mockImplementation((target) => {
			if (path.resolve(String(target)) === path.resolve(compiled)) return true;
			return true;
		});
		const realpath = vi
			.spyOn(fs, "realpathSync")
			.mockImplementation((target) => path.resolve(String(target)));
		try {
			expect(sandboxRunnerPath()).toBe(path.resolve(compiled));
		} finally {
			spy.mockRestore();
			realpath.mockRestore();
		}
	});

	it("falls back to this module when compiled scripts.js is absent", () => {
		const compiled = path.join(__dirname, "scripts.js");
		const spy = vi.spyOn(fs, "existsSync").mockImplementation((target) => {
			if (path.resolve(String(target)) === path.resolve(compiled)) return false;
			return true;
		});
		try {
			const runner = sandboxRunnerPath();
			expect(runner).toContain("scripts.");
			expect(path.isAbsolute(runner)).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});
});
