import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RegistryConditionKind } from "./condition-kind";
import {
	createHandlerRuntime,
	getScriptExecutor,
	inferConditionDefault,
	localScriptPath,
	runAfterInstallHook,
	runBeforeWriteHook,
	runInstallHookOptions,
	setScriptExecutor,
} from "./handlers";
import { NpmPackageManager } from "./packages";
import type { ScriptExecutor } from "./scripts";

describe("core/handlers", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "handlers-"));
		setScriptExecutor(undefined);
	});

	afterEach(() => {
		setScriptExecutor(undefined);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("script executor accessors", () => {
		it("stores and clears the active script executor", () => {
			expect(getScriptExecutor()).toBeUndefined();
			const executor = {
				loadModule: vi.fn(),
			} as unknown as ScriptExecutor;
			setScriptExecutor(executor);
			expect(getScriptExecutor()).toBe(executor);
			setScriptExecutor(undefined);
			expect(getScriptExecutor()).toBeUndefined();
		});
	});

	describe("runInstallHookOptions", () => {
		it("copies item identity and omits unset packIds", () => {
			expect(
				runInstallHookOptions(
					{ itemId: "item" },
					{
						conditions: {},
						packageManager: NpmPackageManager.NPM,
						compiledItem: { files: [] },
					},
				),
			).toEqual({
				itemId: "item",
				conditions: {},
				packageManager: NpmPackageManager.NPM,
				compiledItem: { files: [] },
			});
			expect(
				runInstallHookOptions(
					{ itemId: "item", packIds: ["pack"] },
					{
						conditions: { language: "ts" },
						packageManager: NpmPackageManager.PNPM,
						compiledItem: { files: [{ target: "a.ts", content: "a" }] },
						bindings: { k: "v" },
					},
				),
			).toEqual({
				itemId: "item",
				packIds: ["pack"],
				conditions: { language: "ts" },
				packageManager: NpmPackageManager.PNPM,
				compiledItem: { files: [{ target: "a.ts", content: "a" }] },
				bindings: { k: "v" },
			});
		});
	});

	describe("localScriptPath", () => {
		it("joins a relative script under a local registry", () => {
			const catalog = path.join(tempDir, "registry.json");
			expect(localScriptPath(catalog, "r/item.beforeWrite.0.js")).toBe(
				path.join(tempDir, "r/item.beforeWrite.0.js"),
			);
		});

		it("trims surrounding whitespace on the script URI", () => {
			const catalog = path.join(tempDir, "registry.json");
			expect(localScriptPath(catalog, "  r/item.beforeWrite.0.js  ")).toBe(
				path.join(tempDir, "r/item.beforeWrite.0.js"),
			);
		});

		it("rejects empty and whitespace-only script URIs", () => {
			const catalog = path.join(tempDir, "registry.json");
			expect(() => localScriptPath(catalog, "")).toThrow(
				"Script URI must not be empty.",
			);
			expect(() => localScriptPath(catalog, "   ")).toThrow(
				"Script URI must not be empty.",
			);
		});

		it("rejects remote HTTPS registries", () => {
			expect(() =>
				localScriptPath(
					"https://example.com/registry.json",
					"r/item.beforeWrite.0.js",
				),
			).toThrow("local registry");
		});

		it("rejects a relative registry index location", () => {
			expect(() =>
				localScriptPath("registry.json", "r/item.beforeWrite.0.js"),
			).toThrow(
				"Registry index location must be an absolute path or HTTPS URL.",
			);
		});

		it("rejects parent-directory escapes with Script URI wording", () => {
			const catalog = path.join(tempDir, "registry.json");
			expect(() =>
				localScriptPath(catalog, "r/../outside.beforeWrite.0.js"),
			).toThrow(
				'Script URI "r/../outside.beforeWrite.0.js" must be a relative path under the registry directory.',
			);
		});

		it("rejects absolute HTTP script URIs", () => {
			const catalog = path.join(tempDir, "registry.json");
			expect(() =>
				localScriptPath(catalog, "https://evil.example/h.js"),
			).toThrow("relative path under the registry directory");
		});
	});

	describe("runBeforeWriteHook script loading", () => {
		const runtime = () =>
			createHandlerRuntime(tempDir, {
				isFile: vi.fn(async () => false),
				readFile: vi.fn(async () => ""),
				run: vi.fn(async () => ""),
			});

		it("loads a default-exported install hook function", async () => {
			const catalog = path.join(tempDir, "registry.json");
			const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
			fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
			fs.writeFileSync(
				scriptPath,
				"module.exports = { default: async function beforeWrite() {} };\n",
			);

			await expect(
				runBeforeWriteHook(catalog, "r/item.beforeWrite.0.js", runtime(), {
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				}),
			).resolves.toEqual({ files: [], bindings: {} });
		});

		it("loads a module that exports the hook function directly", async () => {
			const catalog = path.join(tempDir, "registry.json");
			const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
			fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
			fs.writeFileSync(
				scriptPath,
				"module.exports = async function beforeWrite() { return { files: [] }; };\n",
			);

			await expect(
				runBeforeWriteHook(catalog, "r/item.beforeWrite.0.js", runtime(), {
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				}),
			).resolves.toEqual({ files: [], bindings: {} });
		});

		it("rejects modules without an install hook function", async () => {
			const catalog = path.join(tempDir, "registry.json");
			const scriptPath = path.join(tempDir, "r/bad.beforeWrite.0.js");
			fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
			fs.writeFileSync(scriptPath, "module.exports = {};\n");

			await expect(
				runBeforeWriteHook(catalog, "r/bad.beforeWrite.0.js", runtime(), {
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				}),
			).rejects.toThrow("must export a `beforeWrite` hook function");
		});

		it("rejects null and non-function install hook exports", async () => {
			const catalog = path.join(tempDir, "registry.json");

			for (const [name, source] of [
				["null", "module.exports = null;\n"],
				["number", "module.exports = 42;\n"],
				["object", "module.exports = { async beforeWrite() {} };\n"],
			] as const) {
				const scriptPath = path.join(tempDir, `r/${name}.beforeWrite.0.js`);
				fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
				fs.writeFileSync(scriptPath, source);

				await expect(
					runBeforeWriteHook(catalog, `r/${name}.beforeWrite.0.js`, runtime(), {
						itemId: "item",
						conditions: {},
						packageManager: NpmPackageManager.NPM,
						compiledItem: { files: [] },
					}),
				).rejects.toThrow("must export a `beforeWrite` hook function");
			}
		});
	});

	describe("inferConditionDefault handler loading", () => {
		const runtime = () =>
			createHandlerRuntime(tempDir, {
				isFile: vi.fn(async () => false),
				readFile: vi.fn(async () => ""),
				run: vi.fn(async () => ""),
			});

		it("loads a default-exported condition handler", async () => {
			const catalog = path.join(tempDir, "registry.json");
			const handlerPath = path.join(tempDir, "r/_handlers/language.handler.js");
			fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
			fs.writeFileSync(
				handlerPath,
				"module.exports = { default: { async infer() { return 'typescript'; } } };\n",
			);

			await expect(
				inferConditionDefault(
					catalog,
					{
						key: "language",
						label: "Language",
						kind: RegistryConditionKind.SELECT,
						values: [{ value: "typescript", label: "TypeScript" }],
						handler: "r/_handlers/language.handler.js",
					},
					runtime(),
					{},
				),
			).resolves.toBe("typescript");
		});

		it("rejects modules without an infer hook", async () => {
			const catalog = path.join(tempDir, "registry.json");
			const handlerPath = path.join(tempDir, "r/_handlers/bad.handler.js");
			fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
			fs.writeFileSync(
				handlerPath,
				'module.exports = { infer: "not a function" };\n',
			);

			await expect(
				inferConditionDefault(
					catalog,
					{
						key: "language",
						label: "Language",
						kind: RegistryConditionKind.SELECT,
						values: [{ value: "typescript", label: "TypeScript" }],
						handler: "r/_handlers/bad.handler.js",
					},
					runtime(),
					{},
				),
			).rejects.toThrow("condition handler with an infer hook");
		});

		it("rejects null and non-object condition handler exports", async () => {
			const catalog = path.join(tempDir, "registry.json");

			for (const [name, source] of [
				["null", "module.exports = null;\n"],
				["number", "module.exports = 1;\n"],
			] as const) {
				const handlerPath = path.join(
					tempDir,
					`r/_handlers/${name}.handler.js`,
				);
				fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
				fs.writeFileSync(handlerPath, source);

				await expect(
					inferConditionDefault(
						catalog,
						{
							key: "language",
							label: "Language",
							kind: RegistryConditionKind.SELECT,
							values: [{ value: "typescript", label: "TypeScript" }],
							handler: `r/_handlers/${name}.handler.js`,
						},
						runtime(),
						{},
					),
				).rejects.toThrow("condition handler with an infer hook");
			}
		});
	});

	it("createHandlerRuntime joins relative paths to projectDir", async () => {
		const isFile = vi.fn(async () => true);
		const isDirectory = vi.fn(async () => true);
		const readFile = vi.fn(async () => "contents");
		const runtime = createHandlerRuntime("/project", {
			isFile,
			isDirectory,
			readFile,
			run: vi.fn(async () => ""),
		});

		await runtime.isFile("tsconfig.json");
		expect(isFile).toHaveBeenCalledWith("/project/tsconfig.json");

		await runtime.isDirectory(".cursor/rules");
		expect(isDirectory).toHaveBeenCalledWith("/project/.cursor/rules");

		await runtime.readFile("src/a.ts");
		expect(readFile).toHaveBeenCalledWith("/project/src/a.ts");
	});

	it("createHandlerRuntime confines absolute paths to the project directory", async () => {
		const isFile = vi.fn(async () => true);
		const isDirectory = vi.fn(async () => true);
		const readFile = vi.fn(async () => "contents");
		const runtime = createHandlerRuntime("/project", {
			isFile,
			isDirectory,
			readFile,
			run: vi.fn(async () => ""),
		});

		await runtime.isFile("/project/src/file.ts");
		expect(isFile).toHaveBeenCalledWith("/project/src/file.ts");

		await runtime.isDirectory("/project/src");
		expect(isDirectory).toHaveBeenCalledWith("/project/src");

		await runtime.readFile("/project/src/file.ts");
		expect(readFile).toHaveBeenCalledWith("/project/src/file.ts");

		await expect(runtime.isFile("/abs/file.ts")).rejects.toThrow(
			'Handler path "/abs/file.ts" escapes the project directory.',
		);
		await expect(runtime.isDirectory("/abs/dir")).rejects.toThrow(
			'Handler path "/abs/dir" escapes the project directory.',
		);
		await expect(runtime.readFile("../.ssh/id_rsa")).rejects.toThrow(
			"must be a relative path under the project directory",
		);
	});

	it("createHandlerRuntime fails closed when isDirectory helper is omitted", async () => {
		const runtime = createHandlerRuntime("/project", {
			isFile: vi.fn(async () => true),
			readFile: vi.fn(async () => "contents"),
			run: vi.fn(async () => ""),
		});

		await expect(runtime.isDirectory("some/dir")).resolves.toBe(false);
	});

	it("inferConditionDefault returns schema default when no handler is declared", async () => {
		const runtime = createHandlerRuntime("/project", {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		await expect(
			inferConditionDefault(
				"/catalog/registry.json",
				{
					key: "coverageThreshold",
					label: "Coverage",
					kind: RegistryConditionKind.TEXT,
					values: [],
					default: "45",
				},
				runtime,
				{},
			),
		).resolves.toBe("45");
	});

	it("inferConditionDefault skips handlers when allowHandler is false", async () => {
		const runtime = createHandlerRuntime("/project", {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		await expect(
			inferConditionDefault(
				"/catalog/registry.json",
				{
					key: "coverageThreshold",
					label: "Coverage",
					kind: RegistryConditionKind.TEXT,
					values: [],
					default: "80",
					handler: "r/missing.handler.js",
				},
				runtime,
				{},
				{ allowHandler: false },
			),
		).resolves.toBe("80");
	});

	it("inferConditionDefault returns undefined without a handler or default", async () => {
		const runtime = createHandlerRuntime("/project", {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		await expect(
			inferConditionDefault(
				"/catalog/registry.json",
				{
					key: "language",
					label: "Language",
					kind: RegistryConditionKind.SELECT,
					values: [{ value: "typescript", label: "TypeScript" }],
				},
				runtime,
				{},
			),
		).resolves.toBeUndefined();
	});

	it("inferConditionDefault does not special-case packageManager without a handler", async () => {
		fs.writeFileSync(path.join(tempDir, "pnpm-lock.yaml"), "");
		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		await expect(
			inferConditionDefault(
				"/catalog/registry.json",
				{
					key: "packageManager",
					label: "Package manager",
					kind: RegistryConditionKind.SELECT,
					values: [
						{ value: "npm", label: "npm" },
						{ value: "pnpm", label: "pnpm" },
					],
				},
				runtime,
				{},
			),
		).resolves.toBeUndefined();
	});

	it("inferConditionDefault uses a schema default when packageManager has no handler", async () => {
		fs.writeFileSync(path.join(tempDir, "pnpm-lock.yaml"), "");
		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		await expect(
			inferConditionDefault(
				"/catalog/registry.json",
				{
					key: "packageManager",
					label: "Package manager",
					kind: RegistryConditionKind.SELECT,
					values: [{ value: "npm", label: "npm" }],
					default: "npm",
				},
				runtime,
				{},
			),
		).resolves.toBe("npm");
	});

	it("inferConditionDefault prefers a declared handler over a schema default", async () => {
		fs.writeFileSync(path.join(tempDir, "pnpm-lock.yaml"), "");
		const catalog = path.join(tempDir, "registry.json");
		const handlerPath = path.join(
			tempDir,
			"r/_handlers/packageManager.handler.js",
		);
		fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
		fs.writeFileSync(
			handlerPath,
			"module.exports = { async infer() { return 'npm'; } };\n",
		);
		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		await expect(
			inferConditionDefault(
				catalog,
				{
					key: "packageManager",
					label: "Package manager",
					kind: RegistryConditionKind.SELECT,
					values: [
						{ value: "npm", label: "npm" },
						{ value: "pnpm", label: "pnpm" },
					],
					handler: "r/_handlers/packageManager.handler.js",
				},
				runtime,
				{},
			),
		).resolves.toBe("npm");
	});

	it("inferConditionDefault falls back to schema default when infer returns undefined", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const handlerPath = path.join(tempDir, "r/_handlers/fallback.handler.js");
		fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
		fs.writeFileSync(
			handlerPath,
			"module.exports = { async infer() { return undefined; } };\n",
		);
		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		await expect(
			inferConditionDefault(
				catalog,
				{
					key: "coverageThreshold",
					label: "Coverage",
					kind: RegistryConditionKind.TEXT,
					values: [],
					default: "45",
					handler: "r/_handlers/fallback.handler.js",
				},
				runtime,
				{},
			),
		).resolves.toBe("45");
	});

	it("inferConditionDefault passes optional description and values only when present", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const capturePath = path.join(tempDir, "capture.json");

		async function writeCaptureInfer(name: string): Promise<string> {
			const handlerPath = path.join(tempDir, `r/_handlers/${name}.handler.js`);
			fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
			fs.writeFileSync(
				handlerPath,
				`
const fs = require("node:fs");
module.exports = {
  async infer(ctx) {
    fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
      key: ctx.key,
      label: ctx.label,
      description: ctx.description,
      values: ctx.values,
      hasDescription: Object.hasOwn(ctx, "description"),
      hasValues: Object.hasOwn(ctx, "values"),
      conditions: ctx.conditions,
    }));
    return "typescript";
  }
};
`,
			);
			return `r/_handlers/${name}.handler.js`;
		}

		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		const withExtras = await writeCaptureInfer("with-extras");
		await inferConditionDefault(
			catalog,
			{
				key: "language",
				label: "Language",
				description: "Pick a language",
				kind: RegistryConditionKind.SELECT,
				values: [{ value: "typescript", label: "TypeScript" }],
				handler: withExtras,
			},
			runtime,
			{ language: "typescript" },
		);

		expect(JSON.parse(fs.readFileSync(capturePath, "utf8"))).toEqual({
			key: "language",
			label: "Language",
			description: "Pick a language",
			values: [{ value: "typescript", label: "TypeScript" }],
			hasDescription: true,
			hasValues: true,
			conditions: { language: "typescript" },
		});

		const withoutExtras = await writeCaptureInfer("without-extras");
		await inferConditionDefault(
			catalog,
			{
				key: "author",
				label: "Author",
				kind: RegistryConditionKind.TEXT,
				values: [],
				handler: withoutExtras,
			},
			runtime,
			{},
		);

		expect(JSON.parse(fs.readFileSync(capturePath, "utf8"))).toEqual({
			key: "author",
			label: "Author",
			hasDescription: false,
			hasValues: false,
			conditions: {},
		});
	});

	it("inferConditionDefault converts inferred values by kind", async () => {
		const catalog = path.join(tempDir, "registry.json");

		async function writeInfer(name: string, body: string): Promise<string> {
			const handlerPath = path.join(tempDir, `r/_handlers/${name}.handler.js`);
			fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
			fs.writeFileSync(
				handlerPath,
				`module.exports = { async infer() { ${body} } };\n`,
			);
			return `r/_handlers/${name}.handler.js`;
		}

		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		const selectUri = await writeInfer("select", 'return "typescript";');
		await expect(
			inferConditionDefault(
				catalog,
				{
					key: "language",
					label: "Language",
					kind: RegistryConditionKind.SELECT,
					values: [{ value: "typescript", label: "TypeScript" }],
					handler: selectUri,
				},
				runtime,
				{},
			),
		).resolves.toBe("typescript");

		const invalidSelectUri = await writeInfer("bad-select", 'return "python";');
		await expect(
			inferConditionDefault(
				catalog,
				{
					key: "language",
					label: "Language",
					kind: RegistryConditionKind.SELECT,
					values: [{ value: "typescript", label: "TypeScript" }],
					handler: invalidSelectUri,
				},
				runtime,
				{},
			),
		).resolves.toBeUndefined();

		const boolUri = await writeInfer("bool", 'return "true";');
		await expect(
			inferConditionDefault(
				catalog,
				{
					key: "enableCi",
					label: "Enable CI",
					description: "Toggle CI",
					kind: RegistryConditionKind.BOOLEAN,
					values: [],
					handler: boolUri,
				},
				runtime,
				{},
			),
		).resolves.toBe(true);

		const emptyTextUri = await writeInfer("empty-text", 'return "";');
		await expect(
			inferConditionDefault(
				catalog,
				{
					key: "author",
					label: "Author",
					kind: RegistryConditionKind.TEXT,
					values: [],
					handler: emptyTextUri,
				},
				runtime,
				{},
			),
		).resolves.toBeUndefined();

		const undefinedUri = await writeInfer("undef", "return undefined;");
		await expect(
			inferConditionDefault(
				catalog,
				{
					key: "author",
					label: "Author",
					kind: RegistryConditionKind.TEXT,
					values: [],
					handler: undefinedUri,
				},
				runtime,
				{},
			),
		).resolves.toBeUndefined();

		const multiUri = await writeInfer("multi", 'return ["ios", "web"];');
		await expect(
			inferConditionDefault(
				catalog,
				{
					key: "platforms",
					label: "Platforms",
					kind: RegistryConditionKind.MULTISELECT,
					values: [
						{ value: "ios", label: "iOS" },
						{ value: "android", label: "Android" },
					],
					handler: multiUri,
				},
				runtime,
				{},
			),
		).resolves.toBeUndefined();
	});

	it("runBeforeWriteHook upserts returned files and merges bindings", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite(ctx) {
  const name = ctx.bindings.prior;
  return {
    bindings: { greeting: "Hello " + name },
    files: [
      { target: "GREETING.md", content: "Hello " + name },
    ],
  };
};
`,
		);

		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		const result = await runBeforeWriteHook(
			catalog,
			"r/item.beforeWrite.0.js",
			runtime,
			{
				itemId: "item",
				packIds: ["default"],
				conditions: {},
				packageManager: NpmPackageManager.NPM,
				bindings: { prior: "Ada" },
				compiledItem: { files: [{ target: "EXISTING", content: "x" }] },
			},
		);

		expect(result.bindings).toEqual({ prior: "Ada", greeting: "Hello Ada" });
		expect(result.files).toEqual([
			{ target: "EXISTING", content: "x" },
			{ target: "GREETING.md", content: "Hello Ada" },
		]);
	});

	it("runBeforeWriteHook isolates mutable context data", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite(ctx) {
  ctx.bindings.mutated = "yes";
  ctx.conditions.mode = "changed";
  ctx.compiledItem.files.push({ target: "MUTATED", content: "no" });
};
`,
		);

		const options = {
			itemId: "item",
			conditions: { mode: "original" },
			bindings: { prior: "Ada" },
			compiledItem: { files: [{ target: "KEEP", content: "yes" }] },
		};
		const result = await runBeforeWriteHook(
			catalog,
			"r/item.beforeWrite.0.js",
			createHandlerRuntime(tempDir, {
				isFile: vi.fn(async () => false),
				readFile: vi.fn(async () => ""),
				run: vi.fn(async () => ""),
			}),
			options,
		);

		expect(result).toEqual({
			files: [{ target: "KEEP", content: "yes" }],
			bindings: { prior: "Ada" },
		});
		expect(options.conditions).toEqual({ mode: "original" });
		expect(options.compiledItem.files).toEqual([
			{ target: "KEEP", content: "yes" },
		]);
	});

	it("runBeforeWriteHook upserts by target and honors removeFiles", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return {
    removeFiles: ["DROP"],
    files: [{ target: "KEEP", content: "updated" }],
  };
};
`,
		);

		const result = await runBeforeWriteHook(
			catalog,
			"r/item.beforeWrite.0.js",
			createHandlerRuntime(tempDir, {
				isFile: vi.fn(async () => false),
				readFile: vi.fn(async () => ""),
				run: vi.fn(async () => ""),
			}),
			{
				itemId: "item",
				conditions: {},
				packageManager: NpmPackageManager.NPM,
				compiledItem: {
					files: [
						{ target: "KEEP", content: "old" },
						{ target: "DROP", content: "gone" },
					],
				},
			},
		);

		expect(result.files).toEqual([{ target: "KEEP", content: "updated" }]);
	});

	it("runBeforeWriteHook rejects unknown result keys", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return { file: [{ target: "x", content: "y" }] };
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js" returned unknown key "file".',
		);
	});

	it("runBeforeWriteHook rejects a file target that escapes the project", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return { files: [{ target: "../secret.txt", content: "x" }] };
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js".files[0].target must be a relative path (no absolute paths, URLs, or "..").',
		);
	});

	it("runBeforeWriteHook rejects a __proto__ binding key", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  const bindings = Object.create(null);
  Object.defineProperty(bindings, "__proto__", {
    value: "pwned",
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return { bindings };
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js" binding "__proto__" is not allowed.',
		);
	});

	it("runBeforeWriteHook rejects a reserved interpolation binding", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return { bindings: { packageManager: "npm" } };
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js" binding "packageManager" is reserved.',
		);
	});

	it("runBeforeWriteHook rejects a non-string binding value", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return { bindings: { x: 1 } };
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js" binding "x" must be a string.',
		);
	});

	it("runBeforeWriteHook rejects an empty binding key", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  const bindings = {};
  bindings[""] = "value";
  return { bindings };
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js" binding "" is not allowed.',
		);
	});

	it("runBeforeWriteHook rejects bindings that are not a plain object", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return { bindings: ["not-an-object"] };
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js" bindings must be an object.',
		);
	});

	it("runBeforeWriteHook rejects a non-object result", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return "not-an-object";
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js" must return an object or undefined.',
		);
	});

	it("runBeforeWriteHook rejects commands that are not an object", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return { commands: [] };
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js" commands must be an object.',
		);
	});

	it("runBeforeWriteHook rejects a non-object ecosystem entry", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return { commands: { npm: "bad" } };
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js" commands.npm must be an object.',
		);
	});

	it("runBeforeWriteHook rejects removeFiles that is not an array", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return { removeFiles: "DROP" };
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js" removeFiles must be an array.',
		);
	});

	it("runBeforeWriteHook rejects empty removeFiles entries", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return { removeFiles: [""] };
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js" removeFiles entries must be non-empty strings.',
		);
	});

	it("runBeforeWriteHook loads scripts through the installed executor", async () => {
		const executor: ScriptExecutor = {
			async loadModule<T>(
				_indexLocation: string,
				_scriptUri: string,
				isValid: (value: unknown) => value is T,
				_errorMessage: string,
			): Promise<T> {
				const hook = async () => ({ bindings: { fromExecutor: "1" } });
				if (!isValid(hook)) throw new Error(_errorMessage);
				return hook;
			},
		};
		vi.spyOn(executor, "loadModule");
		setScriptExecutor(executor);
		const result = await runBeforeWriteHook(
			path.join(tempDir, "registry.json"),
			"r/item.beforeWrite.0.js",
			createHandlerRuntime(tempDir, {
				isFile: vi.fn(async () => false),
				readFile: vi.fn(async () => ""),
				run: vi.fn(async () => ""),
			}),
			{
				itemId: "item",
				conditions: {},
				packageManager: NpmPackageManager.NPM,
				compiledItem: { files: [] },
			},
		);
		expect(executor.loadModule).toHaveBeenCalled();
		expect(result.bindings).toEqual({ fromExecutor: "1" });
	});

	it("runBeforeWriteHook rejects an unknown commands ecosystem", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return { commands: { pip: { install: "pip install x" } } };
};
`,
		);
		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					packageManager: NpmPackageManager.NPM,
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js" commands has unknown ecosystem "pip".',
		);
	});

	it("runBeforeWriteHook rejects malformed secret entries", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return { secrets: [42] };
};
`,
		);

		await expect(
			runBeforeWriteHook(
				catalog,
				"r/item.beforeWrite.0.js",
				createHandlerRuntime(tempDir, {
					isFile: vi.fn(async () => false),
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}),
				{
					itemId: "item",
					conditions: {},
					compiledItem: { files: [] },
				},
			),
		).rejects.toThrow(
			'Before-write hook at "r/item.beforeWrite.0.js".secrets[0] must be a non-empty string.',
		);
	});

	it("createHandlerRuntime rejects a relative project directory", () => {
		expect(() =>
			createHandlerRuntime("relative", {
				isFile: vi.fn(async () => false),
				readFile: vi.fn(async () => ""),
				run: vi.fn(async () => ""),
			}),
		).toThrow("Project directory must be an absolute path.");
	});

	it("createHandlerRuntime rethrows unexpected realpath errors", () => {
		vi.spyOn(fs, "realpathSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		});
		expect(() =>
			createHandlerRuntime("/project", {
				isFile: vi.fn(async () => false),
				readFile: vi.fn(async () => ""),
				run: vi.fn(async () => ""),
			}),
		).toThrow("permission denied");
	});

	it("createHandlerRuntime isFile rejects a symlink that points outside the project", async () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "cheetos-link-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cheetos-out-"));
		try {
			fs.writeFileSync(path.join(outside, "secret.txt"), "x");
			fs.symlinkSync(
				path.join(outside, "secret.txt"),
				path.join(project, "link.txt"),
			);
			const isFile = vi.fn(async () => true);
			await expect(
				createHandlerRuntime(project, {
					isFile,
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}).isFile("link.txt"),
			).rejects.toThrow("escapes the project directory");
			expect(isFile).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("createHandlerRuntime rejects a symlinked parent directory outside the project", async () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "cheetos-link-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cheetos-out-"));
		try {
			fs.writeFileSync(path.join(outside, "secret.txt"), "x");
			fs.symlinkSync(outside, path.join(project, "linked"), "dir");
			const isFile = vi.fn(async () => true);
			await expect(
				createHandlerRuntime(project, {
					isFile,
					readFile: vi.fn(async () => ""),
					run: vi.fn(async () => ""),
				}).isFile("linked/secret.txt"),
			).rejects.toThrow("escapes the project directory");
			expect(isFile).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("runBeforeWriteHook merges commands, dependencies, and secrets when the hook returns them", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function beforeWrite() {
  return {
    commands: { npm: { check: "biome check ." } },
    dependencies: { npm: { dev: ["@biomejs/biome@^2"] } },
    secrets: ["SONAR_TOKEN"],
  };
};
`,
		);

		const result = await runBeforeWriteHook(
			catalog,
			"r/item.beforeWrite.0.js",
			createHandlerRuntime(tempDir, {
				isFile: vi.fn(async () => false),
				readFile: vi.fn(async () => ""),
				run: vi.fn(async () => ""),
			}),
			{
				itemId: "item",
				conditions: {},
				packageManager: NpmPackageManager.NPM,
				compiledItem: {
					files: [],
					commands: { npm: { test: "vitest run" } },
					secrets: ["GH_ADMIN_TOKEN"],
				},
			},
		);

		expect(result.commands).toEqual({
			npm: { test: "vitest run", check: "biome check ." },
		});
		expect(result.dependencies).toEqual({
			npm: { dev: ["@biomejs/biome@^2"] },
		});
		expect(result.secrets).toEqual(["GH_ADMIN_TOKEN", "SONAR_TOKEN"]);
	});

	it("runBeforeWriteHook omits packIds from context when unset and preserves files when the hook yields nothing", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const capturePath = path.join(tempDir, "item-capture.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
const fs = require("node:fs");
module.exports = async function beforeWrite(ctx) {
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    itemId: ctx.itemId,
    packIds: ctx.packIds,
    hasPackIds: Object.hasOwn(ctx, "packIds"),
  }));
};
`,
		);

		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		const result = await runBeforeWriteHook(
			catalog,
			"r/item.beforeWrite.0.js",
			runtime,
			{
				itemId: "item",
				conditions: {},
				packageManager: NpmPackageManager.NPM,
				compiledItem: { files: [{ target: "KEEP", content: "yes" }] },
			},
		);

		expect(JSON.parse(fs.readFileSync(capturePath, "utf8"))).toEqual({
			itemId: "item",
			hasPackIds: false,
		});
		expect(result.bindings).toEqual({});
		expect(result.files).toEqual([{ target: "KEEP", content: "yes" }]);
	});

	it("runBeforeWriteHook includes packIds when provided", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const capturePath = path.join(tempDir, "variant-capture.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
const fs = require("node:fs");
module.exports = async function beforeWrite(ctx) {
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    packIds: ctx.packIds,
    hasPackIds: Object.hasOwn(ctx, "packIds"),
  }));
};
`,
		);

		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		await runBeforeWriteHook(catalog, "r/item.beforeWrite.0.js", runtime, {
			itemId: "item",
			packIds: ["v1"],
			conditions: {},
			packageManager: NpmPackageManager.NPM,
			compiledItem: { files: [] },
		});

		expect(JSON.parse(fs.readFileSync(capturePath, "utf8"))).toEqual({
			packIds: ["v1"],
			hasPackIds: true,
		});
	});

	it("runAfterInstallHook includes packIds when provided", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const capturePath = path.join(tempDir, "after-variant.json");
		const scriptPath = path.join(tempDir, "r/item.afterInstall.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
const fs = require("node:fs");
module.exports = async function afterInstall(ctx) {
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    packIds: ctx.packIds,
    hasPackIds: Object.hasOwn(ctx, "packIds"),
  }));
};
`,
		);

		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		await runAfterInstallHook(catalog, "r/item.afterInstall.0.js", runtime, {
			itemId: "item",
			packIds: ["v1"],
			conditions: {},
			packageManager: NpmPackageManager.NPM,
			bindings: {},
			compiledItem: { files: [] },
		});

		expect(JSON.parse(fs.readFileSync(capturePath, "utf8"))).toEqual({
			packIds: ["v1"],
			hasPackIds: true,
		});
	});

	it("runAfterInstallHook throws when the hook returns a value", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.afterInstall.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`
module.exports = async function afterInstall() {
  return {
    files: [{ target: "TOO_LATE", content: "nope" }],
    bindings: { ignored: "yes" },
  };
};
`,
		);

		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		await expect(
			runAfterInstallHook(catalog, "r/item.afterInstall.0.js", runtime, {
				itemId: "item",
				conditions: {},
				packageManager: NpmPackageManager.NPM,
				bindings: { keep: "1" },
				compiledItem: { files: [{ target: "KEEP", content: "yes" }] },
			}),
		).rejects.toThrow(
			'After-install hook at "r/item.afterInstall.0.js" must not return a value.',
		);
	});

	it("runBeforeWriteHook starts from empty bindings and compiled item files", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const scriptPath = path.join(tempDir, "r/item.beforeWrite.0.js");
		fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
		fs.writeFileSync(
			scriptPath,
			`module.exports = async function beforeWrite() { return { files: [] }; };\n`,
		);

		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});

		const result = await runBeforeWriteHook(
			catalog,
			"r/item.beforeWrite.0.js",
			runtime,
			{
				itemId: "item",
				conditions: {},
				packageManager: NpmPackageManager.NPM,
				compiledItem: { files: [] },
			},
		);

		expect(result.bindings).toEqual({});
		expect(result.files).toEqual([]);
	});

	it("runBeforeWriteHook and runAfterInstallHook run independently", async () => {
		const catalog = path.join(tempDir, "registry.json");
		const logPath = path.join(tempDir, "lifecycle.log");
		const beforePath = path.join(tempDir, "r/item.beforeWrite.0.js");
		const afterPath = path.join(tempDir, "r/item.afterInstall.0.js");
		fs.mkdirSync(path.dirname(beforePath), { recursive: true });
		fs.writeFileSync(
			beforePath,
			`
const fs = require("node:fs");
module.exports = async function beforeWrite(ctx) {
  fs.appendFileSync(${JSON.stringify(logPath)}, "before:" + ctx.itemId + "\\n");
};
`,
		);
		fs.writeFileSync(
			afterPath,
			`
const fs = require("node:fs");
module.exports = async function afterInstall(ctx) {
  fs.appendFileSync(${JSON.stringify(logPath)}, "after:" + ctx.itemId + "\\n");
};
`,
		);

		const runtime = createHandlerRuntime(tempDir, {
			isFile: vi.fn(async () => false),
			readFile: vi.fn(async () => ""),
			run: vi.fn(async () => ""),
		});
		const options = {
			itemId: "item",
			conditions: {},
			packageManager: NpmPackageManager.NPM,
			compiledItem: { files: [{ target: "KEEP", content: "yes" }] },
		};

		await runBeforeWriteHook(
			catalog,
			"r/item.beforeWrite.0.js",
			runtime,
			options,
		);
		await runAfterInstallHook(
			catalog,
			"r/item.afterInstall.0.js",
			runtime,
			options,
		);

		expect(fs.readFileSync(logPath, "utf8")).toBe("before:item\nafter:item\n");
	});
});
