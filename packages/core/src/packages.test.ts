import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	assertUniqueCompiledItemTargets,
	buildPackageInstallCommands,
	type CompiledItem,
	type CompiledItemFile,
	compiledItem,
	compiledItemUsesEcosystem,
	detectPackageManagerFromLockfileList,
	ecosystemManagers,
	foldCompiledItems,
	InvalidJsonError,
	isPackageManagerForEcosystem,
	mergeCommandSet,
	mergeCompiledItemFields,
	mergeDependencySet,
	mergeEcosystemMaps,
	mergeSecretNames,
	NpmPackageManager,
	npmEcosystemAdapter,
	packageManagerBindings,
	packageManagerSpec,
	RegistryDependencyKind,
	type RegistryDependencySet,
	RegistryEcosystem,
	selectPackageManager,
} from "./index";

function deps(
	runtime: string[] = [],
	dev: string[] = [],
): RegistryDependencySet {
	return {
		...(runtime.length > 0
			? { [RegistryDependencyKind.RUNTIME]: runtime }
			: {}),
		...(dev.length > 0 ? { [RegistryDependencyKind.DEV]: dev } : {}),
	};
}

function file(target: string, content: string): CompiledItemFile {
	return { target, content };
}

describe("mergeDependencySet", () => {
	test("it should union, dedupe, and sort runtime and dev packages because install commands must be stable", () => {
		expect(
			mergeDependencySet(
				deps(["zod", "left-pad"]),
				deps(["left-pad", "ms"], ["typescript"]),
			),
		).toEqual({ runtime: ["left-pad", "ms", "zod"], dev: ["typescript"] });
	});

	test("it should reject empty and flag-prefixed package names because names become raw install argv", () => {
		expect(() => mergeDependencySet(deps(["-x"]), undefined)).toThrowError(
			'Package name "-x" is not allowed.',
		);
		expect(() => mergeDependencySet(deps([""]), undefined)).toThrowError(
			"Package name must not be empty.",
		);
	});

	test("it should collapse to undefined when both sides are empty because absent fields must stay absent", () => {
		expect(mergeDependencySet(undefined, undefined)).toBeUndefined();
		expect(mergeDependencySet(deps(), deps())).toBeUndefined();
	});
});

describe("mergeCommandSet", () => {
	test("it should let later command sets overwrite earlier names because the closest payload wins", () => {
		expect(
			mergeCommandSet({ build: "tsc", lint: "eslint ." }, { build: "tsc -b" }),
		).toEqual({ build: "tsc -b", lint: "eslint ." });
	});

	test("it should reject empty names, prototype keys, and empty values because commands feed the project manifest", () => {
		expect(() => mergeCommandSet({ "": "x" }, undefined)).toThrowError(
			"Command name must not be empty.",
		);
		expect(() =>
			mergeCommandSet(JSON.parse('{"__proto__": "x"}'), undefined),
		).toThrowError('Command "__proto__" is not allowed.');
		expect(() => mergeCommandSet({ build: "" }, undefined)).toThrowError(
			'Command "build" must be a non-empty string.',
		);
	});
	test("it should accept either argument order and collapse empty command maps because merge order is irrelevant for absent sides", () => {
		expect(mergeCommandSet(undefined, { build: "tsc -b" })).toEqual({
			build: "tsc -b",
		});
		expect(mergeCommandSet(undefined, undefined)).toBeUndefined();
		expect(mergeCommandSet({}, undefined)).toBeUndefined();
	});
});

describe("mergeEcosystemMaps", () => {
	test("it should fold each ecosystem independently and drop empty ones because sparse payloads must stay sparse", () => {
		expect(
			mergeEcosystemMaps(
				mergeDependencySet,
				{ [RegistryEcosystem.NPM]: deps(["zod"]) },
				{ [RegistryEcosystem.NPM]: deps(["ms"], ["typescript"]) },
			),
		).toEqual({
			[RegistryEcosystem.NPM]: { runtime: ["ms", "zod"], dev: ["typescript"] },
		});
		expect(
			mergeEcosystemMaps(mergeDependencySet, undefined, undefined),
		).toBeUndefined();
		expect(mergeEcosystemMaps(mergeDependencySet, {}, {})).toBeUndefined();
	});
});

describe("mergeSecretNames", () => {
	test("it should dedupe and sort secret names because reminders are stable", () => {
		expect(mergeSecretNames(["TOKEN_B", "TOKEN_A"], ["TOKEN_B"])).toEqual([
			"TOKEN_A",
			"TOKEN_B",
		]);
		expect(mergeSecretNames(undefined)).toBeUndefined();
		expect(() => mergeSecretNames([""])).toThrowError(
			"Secret name must not be empty.",
		);
	});
});

describe("compiled item folding", () => {
	test("it should drop absent optional fields on compiledItem because compiled payloads omit what they do not declare", () => {
		expect(compiledItem({ files: [file("src/a.txt", "A")] })).toEqual({
			files: [file("src/a.txt", "A")],
		});
	});

	test("it should omit empty fields on mergeCompiledItemFields because folded payloads stay minimal", () => {
		expect(mergeCompiledItemFields(undefined, undefined)).toEqual({});
	});

	test("it should emit only the optional fields a fold actually produced because compiled payloads omit undeclared fields", () => {
		expect(
			mergeCompiledItemFields({ dependencies: { npm: deps(["zod"]) } }),
		).toEqual({ dependencies: { npm: deps(["zod"]) } });
		expect(
			mergeCompiledItemFields({ commands: { npm: { build: "tsc" } } }),
		).toEqual({ commands: { npm: { build: "tsc" } } });
		expect(mergeCompiledItemFields({ secrets: ["TOKEN"] })).toEqual({
			secrets: ["TOKEN"],
		});
	});

	test("it should drop identical repeated targets and merge payload fields on foldCompiledItems because item files are inlined into packs", () => {
		const base: CompiledItem = compiledItem({
			files: [file("src/shared.txt", "same"), file("src/base.txt", "B")],
			dependencies: { npm: deps(["zod"]) },
			secrets: ["TOKEN"],
		});
		const overlay: CompiledItem = compiledItem({
			files: [file("src/shared.txt", "same"), file("src/overlay.txt", "O")],
			dependencies: { npm: deps(["ms"]) },
			secrets: ["TOKEN"],
		});
		expect(
			foldCompiledItems([base, overlay], (target) => `conflict on ${target}`),
		).toEqual({
			files: [
				file("src/shared.txt", "same"),
				file("src/base.txt", "B"),
				file("src/overlay.txt", "O"),
			],
			dependencies: { npm: { runtime: ["ms", "zod"] } },
			secrets: ["TOKEN"],
		});
	});

	test("it should throw through the caller's message callback on foldCompiledItems when repeated targets differ because silent overwrites would corrupt installs", () => {
		const base: CompiledItem = compiledItem({
			files: [file("src/a.txt", "one")],
		});
		const overlay: CompiledItem = compiledItem({
			files: [file("src/a.txt", "two")],
		});
		expect(() =>
			foldCompiledItems([base, overlay], (target) => `conflict on ${target}`),
		).toThrowError("conflict on src/a.txt");
	});

	test("it should reject duplicates via the caller's message and unsafe targets on assertUniqueCompiledItemTargets because install paths must be safe and unique", () => {
		const duplicateMessage = (target: string) => `dup ${target}`;
		expect(() =>
			assertUniqueCompiledItemTargets(
				[file("src/a.txt", "one"), file("src/a.txt", "two")],
				duplicateMessage,
			),
		).toThrowError("dup src/a.txt");
		expect(() =>
			assertUniqueCompiledItemTargets(
				[file("../escape.txt", "x")],
				duplicateMessage,
			),
		).toThrowError(/must be a relative path/);
		expect(() =>
			assertUniqueCompiledItemTargets([file("", "x")], duplicateMessage),
		).toThrowError(/must be a non-empty relative path/);
	});
});

describe("packageManagerSpec and bindings", () => {
	test("it should bind each manager to its own command fragments because prompts and templates quote real argv", () => {
		expect(
			packageManagerBindings(RegistryEcosystem.NPM, NpmPackageManager.NPM),
		).toEqual({
			pmRun: "npm run",
			pmExec: "npm",
			pmInstall: "npm install",
			pmInstallCi: "npm ci --ignore-scripts",
			pmPublish:
				"npm publish --workspaces --provenance --access public --no-git-checks",
		});
		expect(
			packageManagerBindings(RegistryEcosystem.NPM, NpmPackageManager.PNPM),
		).toMatchObject({
			pmRun: "pnpm",
			pmExec: "pnpm exec",
			pmInstallCi: "pnpm install --ignore-scripts --frozen-lockfile",
		});
	});

	test("it should reject managers that are not valid for the ecosystem because bindings cannot be fabricated", () => {
		expect(() =>
			packageManagerSpec(RegistryEcosystem.NPM, "cargo" as NpmPackageManager),
		).toThrowError('Package manager "cargo" is not valid for ecosystem "npm".');
		expect(
			isPackageManagerForEcosystem(
				RegistryEcosystem.NPM,
				NpmPackageManager.YARN,
			),
		).toBe(true);
		expect(isPackageManagerForEcosystem(RegistryEcosystem.NPM, "cargo")).toBe(
			false,
		);
	});
});

describe("detectPackageManagerFromLockfileList", () => {
	const managers = ecosystemManagers[RegistryEcosystem.NPM];
	const absolute = path.join(os.tmpdir(), "yoinker-packages-detect");

	test("it should return the single matching manager and lockfile because unambiguous lockfiles identify the manager", () => {
		const pathExists = vi.fn(
			(p: string) => path.basename(p) === "pnpm-lock.yaml",
		);
		expect(
			detectPackageManagerFromLockfileList(absolute, managers, pathExists),
		).toEqual({ manager: NpmPackageManager.PNPM, lockfile: "pnpm-lock.yaml" });
	});

	test("it should return undefined for zero or multiple matches because mixed lockfiles cannot identify one manager", () => {
		expect(
			detectPackageManagerFromLockfileList(absolute, managers, () => false),
		).toBeUndefined();
		expect(
			detectPackageManagerFromLockfileList(absolute, managers, () => true),
		).toBeUndefined();
	});

	test("it should reject a relative project directory because detection anchors to an absolute root", () => {
		expect(() =>
			detectPackageManagerFromLockfileList(
				"relative/project",
				managers,
				() => false,
			),
		).toThrowError("Project directory must be an absolute path.");
	});
});

describe("npmEcosystemAdapter.detectFromManifest", () => {
	const managers = ecosystemManagers[RegistryEcosystem.NPM];
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoinker-manifest-"));
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("it should prefer package.json#packageManager over lockfiles because a declared manager is explicit", async () => {
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({ packageManager: "pnpm@9.0.0" }),
		);
		expect(
			await npmEcosystemAdapter.detectFromManifest(
				tempDir,
				managers,
				() => true,
			),
		).toBe(NpmPackageManager.PNPM);
	});

	test("it should return undefined when the manifest or field is missing because absence must not guess", async () => {
		expect(
			await npmEcosystemAdapter.detectFromManifest(
				tempDir,
				managers,
				() => false,
			),
		).toBeUndefined();
		fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({}));
		expect(
			await npmEcosystemAdapter.detectFromManifest(
				tempDir,
				managers,
				() => true,
			),
		).toBeUndefined();
	});

	test("it should wrap malformed package.json in InvalidJsonError because read failures must be explicit", async () => {
		fs.writeFileSync(path.join(tempDir, "package.json"), "{not json");
		await expect(
			npmEcosystemAdapter.detectFromManifest(tempDir, managers, () => true),
		).rejects.toThrowError(InvalidJsonError);
	});

	test("it should reject a non-object package.json document because a manifest that is not an object cannot declare a manager", async () => {
		fs.writeFileSync(path.join(tempDir, "package.json"), "null");
		await expect(
			npmEcosystemAdapter.detectFromManifest(tempDir, managers, () => true),
		).rejects.toThrowError("package.json must be a JSON object.");

		fs.writeFileSync(path.join(tempDir, "package.json"), "[]");
		await expect(
			npmEcosystemAdapter.detectFromManifest(tempDir, managers, () => true),
		).rejects.toThrowError("package.json must be a JSON object.");
	});
});

describe("selectPackageManager", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoinker-select-pm-"));
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("it should prefer the manifest, then lockfiles, then the prompt because explicit declarations beat inference beats asking", async () => {
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({ packageManager: "yarn@4.0.0" }),
		);
		expect(
			await selectPackageManager(
				RegistryEcosystem.NPM,
				tempDir,
				{ select: vi.fn() },
				() => true,
			),
		).toBe(NpmPackageManager.YARN);

		fs.rmSync(path.join(tempDir, "package.json"));
		expect(
			await selectPackageManager(
				RegistryEcosystem.NPM,
				tempDir,
				{ select: vi.fn() },
				(p) => path.basename(p) === "pnpm-lock.yaml",
			),
		).toBe(NpmPackageManager.PNPM);

		const select = vi.fn(async () => "bun");
		expect(
			await selectPackageManager(
				RegistryEcosystem.NPM,
				tempDir,
				{ select },
				() => false,
			),
		).toBe(NpmPackageManager.BUN);
		expect(select).toHaveBeenCalledTimes(1);
	});

	test("it should reject an invalid prompt answer because the selection must name a real manager", async () => {
		await expect(
			selectPackageManager(
				RegistryEcosystem.NPM,
				tempDir,
				{ select: async () => "cargo" },
				() => false,
			),
		).rejects.toThrowError(/Unknown packageManager "cargo"/);
	});
});

describe("selectPackageManager prompt fallback", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoinker-select-pm2-"));
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("it should fall back to the prompt when two managers match lockfiles because ambiguous detection cannot pick a winner", async () => {
		const select = vi.fn(async () => "bun");
		expect(
			await selectPackageManager(
				RegistryEcosystem.NPM,
				tempDir,
				{ select },
				(p) =>
					path.basename(p) === "package-lock.json" ||
					path.basename(p) === "pnpm-lock.yaml",
			),
		).toBe(NpmPackageManager.BUN);

		expect(select).toHaveBeenCalledWith(
			"Which package manager should be used for the project?",
			{
				options: [
					{ label: "npm", value: "npm" },
					{ label: "pnpm", value: "pnpm" },
					{ label: "Yarn", value: "yarn" },
					{ label: "Bun", value: "bun" },
					{ label: "Nub", value: "nub" },
				],
			},
			"npm",
		);
	});

	test("it should prefer the manifest over lockfiles because explicit declarations beat inference", async () => {
		fs.writeFileSync(
			path.join(tempDir, "package.json"),
			JSON.stringify({ packageManager: "yarn@4.0.0" }),
		);
		const select = vi.fn(async () => "npm");
		expect(
			await selectPackageManager(
				RegistryEcosystem.NPM,
				tempDir,
				{ select },
				(p) =>
					path.basename(p) === "pnpm-lock.yaml" ||
					path.basename(p) === "package.json",
			),
		).toBe(NpmPackageManager.YARN);
		expect(select).not.toHaveBeenCalled();
	});
});

describe("buildPackageInstallCommands", () => {
	test("it should build deduped, sorted runtime and dev install commands with exact argv because generated commands must be stable", () => {
		expect(
			buildPackageInstallCommands(
				RegistryEcosystem.NPM,
				NpmPackageManager.NPM,
				deps(["b", "a", "a"], ["c"]),
			),
		).toEqual([
			{
				executable: "npm",
				args: ["install", "--ignore-scripts", "a", "b"],
				display: "npm install --ignore-scripts a b",
			},
			{
				executable: "npm",
				args: ["install", "--ignore-scripts", "-D", "c"],
				display: "npm install --ignore-scripts -D c",
			},
		]);
	});

	test("it should emit a single dev command for dev-only sets because runtime and dev install shapes differ", () => {
		expect(
			buildPackageInstallCommands(
				RegistryEcosystem.NPM,
				NpmPackageManager.NPM,
				deps([], ["c"]),
			),
		).toEqual([
			{
				executable: "npm",
				args: ["install", "--ignore-scripts", "-D", "c"],
				display: "npm install --ignore-scripts -D c",
			},
		]);
	});

	test("it should return no commands for an empty dependency set because there is nothing to install", () => {
		expect(
			buildPackageInstallCommands(
				RegistryEcosystem.NPM,
				NpmPackageManager.NPM,
				{},
			),
		).toEqual([]);
	});

	test("it should reject unsafe package names because install argv must not be smuggled into", () => {
		expect(() =>
			buildPackageInstallCommands(
				RegistryEcosystem.NPM,
				NpmPackageManager.NPM,
				deps(["-p"]),
			),
		).toThrowError('Package name "-p" is not allowed.');
		expect(() =>
			buildPackageInstallCommands(
				RegistryEcosystem.NPM,
				NpmPackageManager.NPM,
				deps([""]),
			),
		).toThrowError("Package name must not be empty.");
	});

	test("it should reject a manager that is not valid for the ecosystem because install argv is manager-specific", () => {
		expect(() =>
			buildPackageInstallCommands(
				RegistryEcosystem.NPM,
				"cargo" as NpmPackageManager,
				deps(["x"]),
			),
		).toThrowError('Package manager "cargo" is not valid for ecosystem "npm".');
	});

	test("it should build pnpm-specific argv because managers differ in install verbs", () => {
		expect(
			buildPackageInstallCommands(
				RegistryEcosystem.NPM,
				NpmPackageManager.PNPM,
				{
					[RegistryDependencyKind.RUNTIME]: ["x"],
					[RegistryDependencyKind.DEV]: ["y"],
				},
			).map((command) => command.args),
		).toEqual([
			["add", "--ignore-scripts", "x"],
			["add", "--ignore-scripts", "-D", "y"],
		]);
	});
});

describe("compiledItemUsesEcosystem", () => {
	function item(
		parts: Partial<Parameters<typeof compiledItem>[0]> = {},
	): CompiledItem {
		return compiledItem({ files: [], ...parts });
	}

	test("it should detect runtime and dev dependencies for the ecosystem because installs need a manager", () => {
		expect(
			compiledItemUsesEcosystem(
				item({ dependencies: { npm: deps(["x"]) } }),
				RegistryEcosystem.NPM,
			),
		).toBe(true);
		expect(
			compiledItemUsesEcosystem(
				item({ dependencies: { npm: deps([], ["x"]) } }),
				RegistryEcosystem.NPM,
			),
		).toBe(true);
	});

	test("it should not need a manager for empty dependency sets because nothing is installed", () => {
		expect(
			compiledItemUsesEcosystem(
				item({ dependencies: { npm: {} } }),
				RegistryEcosystem.NPM,
			),
		).toBe(false);
	});

	test("it should detect non-empty ecosystem commands and ignore empty ones because manifest merges need a manager", () => {
		expect(
			compiledItemUsesEcosystem(
				item({ commands: { npm: { build: "x" } } }),
				RegistryEcosystem.NPM,
			),
		).toBe(true);
		expect(
			compiledItemUsesEcosystem(
				item({ commands: { npm: {} } }),
				RegistryEcosystem.NPM,
			),
		).toBe(false);
	});

	test("it should detect package-manager interpolation tags in file templates because those templates run commands", () => {
		const tagsTrue = [
			"{{ pmInstall }}",
			"{{packageManager}}",
			"run {{ pmRun }} now",
		];
		for (const content of tagsTrue) {
			expect(
				compiledItemUsesEcosystem(
					item({ files: [file("t", content)] }),
					RegistryEcosystem.NPM,
				),
				`file "${content}"`,
			).toBe(true);
		}
	});

	test("it should ignore tags that only look like package-manager bindings because matching must be exact", () => {
		for (const content of ["{{ pmBogus }}", "{{ packageManagerx }}", "hello"]) {
			expect(
				compiledItemUsesEcosystem(
					item({ files: [file("t", content)] }),
					RegistryEcosystem.NPM,
				),
			).toBe(false);
		}
	});

	test("it should not need a manager for plain files without deps or commands because plain file installs are manager-free", () => {
		expect(
			compiledItemUsesEcosystem(
				item({ files: [file("t", "hello")] }),
				RegistryEcosystem.NPM,
			),
		).toBe(false);
	});
});
