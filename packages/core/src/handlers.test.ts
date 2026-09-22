import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RegistryPackageManager } from "./index";
import {
	type CompiledItem,
	type CompiledItemFile,
	createHandlerRuntime,
	type HandlerRuntime,
	inferConditionDefault,
	isFileAsync,
	localScriptPath,
	RegistryConditionKind,
	type RegistryContext,
	type RequiredCondition,
	type RunInstallHookOptions,
	readFileAsync,
	runAfterInstallHook,
	runBeforeWriteHook,
	runInstallHookOptions,
	type ScriptExecutor,
	setScriptExecutor,
} from "./index";

let registryDir: string;
let projectDir: string;

beforeEach(() => {
	registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheetos-handlers-reg-"));
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheetos-handlers-proj-"));
	fs.mkdirSync(path.join(registryDir, "r"), { recursive: true });
});

afterEach(() => {
	setScriptExecutor(undefined);
	fs.rmSync(registryDir, { recursive: true, force: true });
	fs.rmSync(projectDir, { recursive: true, force: true });
});

/** Absolute local registry index path for these fixtures. */
const indexLocation = (): string => path.join(registryDir, "registry.json");

/** Runtime wired to the real fs helpers inside the temp project. */
function realRuntime(): HandlerRuntime {
	return createHandlerRuntime(projectDir, {
		isFile: isFileAsync,
		readFile: readFileAsync,
		run: vi.fn(async () => ""),
	});
}

function hookOptions(
	overrides: Partial<RunInstallHookOptions> = {},
): RunInstallHookOptions {
	return {
		itemId: "button",
		conditions: { framework: "react" },
		compiledItem: {
			files: [
				{ target: "src/a.txt", content: "A" },
				{ target: "src/old.txt", content: "OLD" },
			],
			dependencies: { npm: { runtime: ["left-pad"] } },
			secrets: ["TOKEN"],
		},
		bindings: {},
		...overrides,
	};
}

describe("localScriptPath", () => {
	test("it should join a script URI under the index directory because local scripts resolve like catalog payloads", () => {
		expect(localScriptPath(indexLocation(), "r/hook.js")).toBe(
			path.join(registryDir, "r/hook.js"),
		);
	});

	test("it should reject remote and relative index locations because scripts only execute for absolute local registries", () => {
		expect(() =>
			localScriptPath("https://example.com/registry.json", "r/hook.js"),
		).toThrowError(/Remote HTTPS registries cannot execute custom scripts/);
		expect(() => localScriptPath("registry.json", "r/hook.js")).toThrowError(
			"Registry index location must be an absolute path or HTTPS URL.",
		);
	});

	test("it should reject escaping and empty script URIs because payloads must stay under the registry", () => {
		expect(() => localScriptPath(indexLocation(), "../escape.js")).toThrowError(
			/must be a relative path under the registry directory/,
		);
		expect(() => localScriptPath(indexLocation(), "")).toThrowError(
			"Script URI must not be empty.",
		);
	});
});

describe("createHandlerRuntime", () => {
	test("it should reject a relative project directory because confinement needs an absolute root", () => {
		expect(() =>
			createHandlerRuntime("relative/project", {
				isFile: async () => false,
				readFile: async () => "",
				run: async () => "",
			}),
		).toThrowError("Project directory must be an absolute path.");
	});

	test("it should pass confined absolute paths to isFile and readFile because helpers must never see unanchored paths", async () => {
		const isFile = vi.fn(async () => true);
		const readFile = vi.fn(async () => "content");
		const runtime = createHandlerRuntime(projectDir, {
			isFile,
			readFile,
			run: async () => "",
		});

		await runtime.isFile("src/x.ts");
		await runtime.readFile(path.join(projectDir, "src/x.ts"));

		expect(isFile).toHaveBeenCalledWith(path.join(projectDir, "src/x.ts"));
		expect(readFile).toHaveBeenCalledWith(path.join(projectDir, "src/x.ts"));
	});

	test("it should reject lexical parent-directory escapes and absolute paths outside the root because scripts must stay in the project", async () => {
		const runtime = createHandlerRuntime(projectDir, {
			isFile: async () => false,
			readFile: async () => "",
			run: async () => "",
		});

		await expect(runtime.readFile("../escape.txt")).rejects.toThrowError(
			/must be a relative path under the project directory/,
		);
		await expect(
			runtime.readFile(path.join(os.tmpdir(), "outside.txt")),
		).rejects.toThrowError(/escapes the project directory/);
	});

	test("it should reject symlinked paths that realpath outside the project because lexical confinement alone is bypassable", async () => {
		const outsideDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "cheetos-handlers-out-"),
		);
		fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret");
		fs.symlinkSync(outsideDir, path.join(projectDir, "link"));
		try {
			const runtime = createHandlerRuntime(projectDir, {
				isFile: isFileAsync,
				readFile: readFileAsync,
				run: async () => "",
			});
			await expect(runtime.readFile("link/secret.txt")).rejects.toThrowError(
				/escapes the project directory/,
			);
		} finally {
			fs.rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	test("it should fail closed for isDirectory when no helper is provided and delegate run to the given helper", async () => {
		const run = vi.fn(async () => "done");
		const runtime = createHandlerRuntime(projectDir, {
			isFile: async () => false,
			readFile: async () => "",
			run,
		});
		expect(await runtime.isDirectory("src")).toBe(false);
		expect(await runtime.run("pnpm lint")).toBe("done");
		expect(run).toHaveBeenCalledWith("pnpm lint");
	});
});

describe("runBeforeWriteHook", () => {
	test("it should upsert returned files by target, honor removeFiles, and merge bindings, commands, dependencies, and secrets because hooks extend the working payload", async () => {
		fs.writeFileSync(
			path.join(registryDir, "r/hook.js"),
			"module.exports = async () => ({\n" +
				"\tfiles: [\n" +
				"\t\t{ target: 'src/a.txt', content: 'A2' },\n" +
				"\t\t{ target: 'src/b.txt', content: 'B' },\n" +
				"\t],\n" +
				"\tremoveFiles: ['src/old.txt'],\n" +
				"\tbindings: { hookKey: 'hookValue' },\n" +
				"\tcommands: { npm: { build: 'tsc' } },\n" +
				"\tdependencies: { npm: { dev: ['typescript'] } },\n" +
				"\tsecrets: ['OTHER'],\n" +
				"});",
		);

		const state = await runBeforeWriteHook(
			indexLocation(),
			"r/hook.js",
			realRuntime(),
			hookOptions(),
		);

		expect(state.files).toEqual([
			{ target: "src/a.txt", content: "A2" },
			{ target: "src/b.txt", content: "B" },
		]);
		expect(state.bindings).toEqual({ hookKey: "hookValue" });
		expect(state.commands).toEqual({ npm: { build: "tsc" } });
		expect(state.dependencies).toEqual({
			npm: { runtime: ["left-pad"], dev: ["typescript"] },
		});
		expect(state.secrets).toEqual(["OTHER", "TOKEN"]);
	});

	test("it should pass the hook the item identity, conditions, bindings, and working payload because scripts plan around install state", async () => {
		fs.writeFileSync(
			path.join(registryDir, "r/hook.js"),
			"module.exports = async (ctx) => ({ captured: ctx });",
		);
		await expect(
			runBeforeWriteHook(indexLocation(), "r/hook.js", realRuntime(), {
				...hookOptions({
					bindings: { existing: "yes" },
				}),
				packIds: ["react"],
			}),
		).rejects.toThrowError(/returned unknown key "captured"/);
	});

	test("it should keep the working payload unchanged when the hook returns undefined because hooks are optional", async () => {
		fs.writeFileSync(
			path.join(registryDir, "r/hook.js"),
			"module.exports = async () => undefined;",
		);
		const options = hookOptions();
		const state = await runBeforeWriteHook(
			indexLocation(),
			"r/hook.js",
			realRuntime(),
			options,
		);
		expect(state.files).toEqual(options.compiledItem.files);
		expect(state.bindings).toEqual({});
		expect(state.secrets).toEqual(["TOKEN"]);
	});

	test("it should reject unknown keys, non-object results, reserved bindings, and prototype-keyed bindings because hook output is trusted data", async () => {
		// Distinct script names per case: the in-process require cache is keyed by
		// realpath, which differs from the /var symlink on macOS tmpdirs.
		const cases: Array<[string, RegExp]> = [
			[
				"module.exports = async () => ({ bogus: 1 });",
				/returned unknown key "bogus"/,
			],
			[
				"module.exports = async () => 42;",
				/must return an object or undefined/,
			],
			[
				"module.exports = async () => ({ bindings: { pmRun: 'npm run' } });",
				/binding "pmRun" is reserved/,
			],
			[
				'module.exports = async () => ({ bindings: JSON.parse(\'{"__proto__": "x"}\') });',
				/binding "__proto__" is not allowed/,
			],
		];
		let caseIndex = 0;
		for (const [script, expected] of cases) {
			const scriptUri = `r/hook-${caseIndex++}.js`;
			fs.writeFileSync(path.join(registryDir, scriptUri), script);
			await expect(
				runBeforeWriteHook(
					indexLocation(),
					scriptUri,
					realRuntime(),
					hookOptions(),
				),
			).rejects.toThrowError(expected);
		}
	});

	test("it should reject a non-function export because the hook contract is a function", async () => {
		fs.writeFileSync(
			path.join(registryDir, "r/hook.js"),
			"module.exports = { nope: true };",
		);
		await expect(
			runBeforeWriteHook(
				indexLocation(),
				"r/hook.js",
				realRuntime(),
				hookOptions(),
			),
		).rejects.toThrowError(
			'Script at "r/hook.js" must export a `beforeWrite` hook function.',
		);
	});
});

describe("runAfterInstallHook", () => {
	test("it should resolve when the hook returns nothing because after-install hooks are pure side effects", async () => {
		fs.writeFileSync(
			path.join(registryDir, "r/hook.js"),
			"module.exports = async () => undefined;",
		);
		await expect(
			runAfterInstallHook(
				indexLocation(),
				"r/hook.js",
				realRuntime(),
				hookOptions(),
			),
		).resolves.toBeUndefined();
	});

	test("it should reject a value-returning hook because after-install results have nowhere to go", async () => {
		fs.writeFileSync(
			path.join(registryDir, "r/hook.js"),
			"module.exports = async () => ({ files: [] });",
		);
		await expect(
			runAfterInstallHook(
				indexLocation(),
				"r/hook.js",
				realRuntime(),
				hookOptions(),
			),
		).rejects.toThrowError(
			'After-install hook at "r/hook.js" must not return a value.',
		);
	});
});

describe("script executor seam", () => {
	test("it should route script loads through the installed executor and restore in-process require on reset because the sandbox must replace module loading", async () => {
		const hook: (
			ctx: unknown,
		) => Promise<{ bindings?: Record<string, string> }> = async () => ({
			bindings: { from: "executor" },
		});
		const loadModule = vi.fn(async () => hook);
		const executor: ScriptExecutor = { loadModule };
		setScriptExecutor(executor);

		await expect(
			runBeforeWriteHook(
				indexLocation(),
				"r/hook.js",
				realRuntime(),
				hookOptions(),
			),
		).resolves.toMatchObject({ bindings: { from: "executor" } });
		expect(loadModule).toHaveBeenCalledWith(
			indexLocation(),
			"r/hook.js",
			expect.any(Function),
			'Script at "r/hook.js" must export a `beforeWrite` hook function.',
		);

		// No file exists at r/hook.js, so a reset must fall back to real loading and fail there.
		setScriptExecutor(undefined);
		await expect(
			runBeforeWriteHook(
				indexLocation(),
				"r/hook.js",
				realRuntime(),
				hookOptions(),
			),
		).rejects.toThrowError(/Cannot find module/);
	});
});

describe("inferConditionDefault", () => {
	function inferCondition(
		overrides: Partial<RequiredCondition> = {},
	): RequiredCondition {
		return {
			key: "framework",
			label: "Framework",
			kind: RegistryConditionKind.SELECT,
			values: [
				{ value: "react", label: "React" },
				{ value: "vue", label: "Vue" },
			],
			default: "vue",
			handler: "r/infer.js",
			...overrides,
		};
	}

	test("it should use the handler-suggested value when the handler returns a declared option because inference beats static defaults", async () => {
		fs.writeFileSync(
			path.join(registryDir, "r/infer.js"),
			"module.exports = { infer: async () => 'react' };",
		);
		expect(
			await inferConditionDefault(
				indexLocation(),
				inferCondition(),
				realRuntime(),
				{},
			),
		).toBe("react");
	});

	test("it should fall back to the schema default when the handler returns undefined or an undeclared value because bad suggestions must not leak into context", async () => {
		fs.writeFileSync(
			path.join(registryDir, "r/infer.js"),
			"module.exports = { infer: async () => 'solid' };",
		);
		expect(
			await inferConditionDefault(
				indexLocation(),
				inferCondition(),
				realRuntime(),
				{},
			),
		).toBe("vue");

		fs.writeFileSync(
			path.join(registryDir, "r/infer.js"),
			"module.exports = { infer: async () => undefined };",
		);
		expect(
			await inferConditionDefault(
				indexLocation(),
				inferCondition(),
				realRuntime(),
				{},
			),
		).toBe("vue");
	});

	test("it should skip the handler entirely when allowHandler is false because some install flows disable inference", async () => {
		expect(
			await inferConditionDefault(
				indexLocation(),
				inferCondition(),
				realRuntime(),
				{},
				{ allowHandler: false },
			),
		).toBe("vue");
	});

	test("it should type boolean and text defaults through the kind policy because defaults must match the prompt kind", async () => {
		expect(
			await inferConditionDefault(
				indexLocation(),
				inferCondition({
					kind: RegistryConditionKind.BOOLEAN,
					values: [],
					default: true,
					handler: undefined,
				}),
				realRuntime(),
				{},
			),
		).toBe(true);
		expect(
			await inferConditionDefault(
				indexLocation(),
				inferCondition({
					kind: RegistryConditionKind.TEXT,
					values: [],
					default: "my-app",
					handler: undefined,
				}),
				realRuntime(),
				{},
			),
		).toBe("my-app");
	});

	test("it should return undefined when nothing can be suggested because prompting proceeds without a default", async () => {
		expect(
			await inferConditionDefault(
				indexLocation(),
				inferCondition({ default: undefined, handler: undefined }),
				realRuntime(),
				{},
			),
		).toBeUndefined();
	});

	test("it should reject a handler without an infer hook because the handler contract is an object with infer", async () => {
		fs.writeFileSync(
			path.join(registryDir, "r/infer.js"),
			"module.exports = { nope: true };",
		);
		await expect(
			inferConditionDefault(
				indexLocation(),
				inferCondition(),
				realRuntime(),
				{},
			),
		).rejects.toThrowError(
			'Handler at "r/infer.js" must export a condition handler with an infer hook.',
		);
	});
});

describe("runInstallHookOptions", () => {
	test("it should merge node identity with install state and omit absent packIds because hooks receive a stable context shape", () => {
		const rest = {
			conditions: { framework: "react" } satisfies RegistryContext,
			packageManager: "pnpm" as RegistryPackageManager,
			bindings: { key: "value" },
			compiledItem: { files: [] } as CompiledItem,
		};
		expect(runInstallHookOptions({ itemId: "button" }, rest)).toEqual({
			itemId: "button",
			...rest,
		});
		expect(
			runInstallHookOptions({ itemId: "button", packIds: ["react"] }, rest),
		).toEqual({ itemId: "button", packIds: ["react"], ...rest });
	});
});
