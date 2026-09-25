import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type CompiledItem,
	compiledItem,
	NpmPackageManager,
	type RegistryEcosystemDependencies,
} from "@recipebook/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installDeclaredPackages, mergeProjectCommands } from "./packages";

/**
 * `@recipebook/core` resolves to built CJS in node_modules, so `node:child_process`
 * cannot be intercepted; mock the core shell wrapper instead, which is the
 * process boundary `installDeclaredPackages` actually calls.
 */
const shellMocks = vi.hoisted(() => ({
	runArgvAsync: vi.fn(),
}));
vi.mock("@recipebook/core", async (importOriginal) => ({
	...(await importOriginal()),
	runArgvAsync: shellMocks.runArgvAsync,
}));

const promptsMocks = vi.hoisted(() => ({
	confirmInput: vi.fn(),
}));
vi.mock("../cli/prompts/confirm", () => ({
	confirmInput: promptsMocks.confirmInput,
}));

const tasksMocks = vi.hoisted(() => ({
	runWithTasks: vi.fn(async (_title: string, work: () => Promise<void>) =>
		work(),
	),
}));
vi.mock("../cli/tasks", () => tasksMocks);

let projectDir: string;

beforeEach(() => {
	shellMocks.runArgvAsync.mockReset();
	shellMocks.runArgvAsync.mockResolvedValue("");
	promptsMocks.confirmInput.mockReset();
	promptsMocks.confirmInput.mockResolvedValue(true);
	tasksMocks.runWithTasks.mockClear();
	// The install/merge UX prints "Packages to install:" and script-overwrite lists;
	// silence them so CI/tests stay quiet (restored by afterEach's restoreAllMocks).
	vi.spyOn(console, "log").mockImplementation(() => {});
	projectDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "recipebook-packages-")),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("installDeclaredPackages", () => {
	test("it should return nothing without prompting when no payload declares packages because there is nothing to install", async () => {
		await expect(
			installDeclaredPackages([], projectDir, NpmPackageManager.PNPM),
		).resolves.toEqual([]);

		expect(promptsMocks.confirmInput).not.toHaveBeenCalled();
		expect(shellMocks.runArgvAsync).not.toHaveBeenCalled();
	});

	test("it should build the selected manager's install argv and run it with the project cwd because the package manager process is the true execution boundary", async () => {
		const declarations: RegistryEcosystemDependencies[] = [
			{ npm: { runtime: ["zod"], dev: ["vitest"] } },
		];

		await expect(
			installDeclaredPackages(declarations, projectDir, NpmPackageManager.PNPM),
		).resolves.toEqual([]);

		expect(promptsMocks.confirmInput).toHaveBeenCalledTimes(1);
		expect(promptsMocks.confirmInput).toHaveBeenCalledWith(
			"Install required dependencies?",
			{},
			true,
		);
		expect(shellMocks.runArgvAsync).toHaveBeenCalledTimes(2);
		expect(shellMocks.runArgvAsync).toHaveBeenCalledWith(
			"pnpm",
			["add", "--ignore-scripts", "zod"],
			{ cwd: projectDir, stdio: "inherit" },
		);
		expect(shellMocks.runArgvAsync).toHaveBeenCalledWith(
			"pnpm",
			["add", "--ignore-scripts", "-D", "vitest"],
			{ cwd: projectDir, stdio: "inherit" },
		);
	});

	test("it should return the display commands without running anything when the user declines because the user still needs to know what to install", async () => {
		promptsMocks.confirmInput.mockResolvedValue(false);

		await expect(
			installDeclaredPackages(
				[{ npm: { runtime: ["zod"], dev: ["vitest"] } }],
				projectDir,
				NpmPackageManager.PNPM,
			),
		).resolves.toEqual([
			"pnpm add --ignore-scripts zod",
			"pnpm add --ignore-scripts -D vitest",
		]);

		expect(shellMocks.runArgvAsync).not.toHaveBeenCalled();
	});

	test("it should reject when the project directory is missing because running installs in a missing cwd would fail obscurely", async () => {
		await expect(
			installDeclaredPackages(
				[{ npm: { runtime: ["zod"] } }],
				path.join(projectDir, "missing"),
				NpmPackageManager.PNPM,
			),
		).rejects.toThrow(/project directory was not found/);
	});

	test("it should reject when the install command exits nonzero because a silent partial install would hide breakage", async () => {
		shellMocks.runArgvAsync.mockRejectedValue(
			new Error("Command failed: pnpm add --ignore-scripts zod (exit 1)"),
		);

		await expect(
			installDeclaredPackages(
				[{ npm: { runtime: ["zod"] } }],
				projectDir,
				NpmPackageManager.PNPM,
			),
		).rejects.toThrow(/Command failed/);
	});

	test("it should dedupe and sort package names across payloads because the install command must be stable and minimal", async () => {
		const declarations: RegistryEcosystemDependencies[] = [
			{ npm: { runtime: ["zod"] } },
			{ npm: { runtime: ["react", "zod"] } },
		];

		await installDeclaredPackages(
			declarations,
			projectDir,
			NpmPackageManager.PNPM,
		);

		expect(shellMocks.runArgvAsync).toHaveBeenCalledTimes(1);
		expect(shellMocks.runArgvAsync).toHaveBeenCalledWith(
			"pnpm",
			["add", "--ignore-scripts", "react", "zod"],
			{ cwd: projectDir, stdio: "inherit" },
		);
	});
});

describe("mergeProjectCommands", () => {
	function writePackageJson(value: unknown): void {
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			`${JSON.stringify(value, null, 2)}\n`,
		);
	}

	function readPackageJsonText(): string {
		return fs.readFileSync(path.join(projectDir, "package.json"), "utf8");
	}

	function itemWithCommands(commands: Record<string, string>): CompiledItem {
		return compiledItem({ files: [], commands: { npm: commands } });
	}

	test("it should add new scripts from every compiled item without prompting because new names cannot clobber anything", async () => {
		writePackageJson({ name: "app", scripts: { build: "tsc" } });

		await mergeProjectCommands(projectDir, [
			itemWithCommands({ format: "prettier --write ." }),
			itemWithCommands({ lint: "eslint ." }),
		]);

		const packageJson = JSON.parse(readPackageJsonText()) as {
			scripts: Record<string, string>;
		};
		expect(packageJson.scripts).toEqual({
			build: "tsc",
			format: "prettier --write .",
			lint: "eslint .",
		});
		expect(promptsMocks.confirmInput).not.toHaveBeenCalled();
	});

	test("it should prompt before replacing a differing script and keep the old value when declined because silent replacement loses user work", async () => {
		writePackageJson({ name: "app", scripts: { test: "vitest" } });
		const originalText = readPackageJsonText();
		promptsMocks.confirmInput.mockResolvedValue(false);

		await mergeProjectCommands(
			projectDir,
			[itemWithCommands({ test: "vitest run" })],
			false,
		);

		expect(promptsMocks.confirmInput).toHaveBeenCalledTimes(1);
		expect(promptsMocks.confirmInput).toHaveBeenCalledWith(
			expect.stringContaining('package.json script "test" already exists'),
			{},
			false,
		);
		expect(readPackageJsonText()).toBe(originalText);
	});

	test("it should replace the script when the user accepts the prompt because consent was given", async () => {
		writePackageJson({ name: "app", scripts: { test: "vitest" } });
		promptsMocks.confirmInput.mockResolvedValue(true);

		await mergeProjectCommands(
			projectDir,
			[itemWithCommands({ test: "vitest run" })],
			false,
		);

		const packageJson = JSON.parse(readPackageJsonText()) as {
			scripts: Record<string, string>;
		};
		expect(packageJson.scripts.test).toBe("vitest run");
	});

	test("it should skip the replacement prompt with overwrite=true because --overwrite means skip confirmations", async () => {
		writePackageJson({ name: "app", scripts: { test: "vitest" } });

		await mergeProjectCommands(
			projectDir,
			[itemWithCommands({ test: "vitest run" })],
			true,
		);

		expect(promptsMocks.confirmInput).not.toHaveBeenCalled();
		const packageJson = JSON.parse(readPackageJsonText()) as {
			scripts: Record<string, string>;
		};
		expect(packageJson.scripts.test).toBe("vitest run");
	});

	test("it should leave the file untouched without prompting when the payload command matches the existing script because there is nothing to change", async () => {
		writePackageJson({ name: "app", scripts: { test: "vitest" } });
		const originalText = readPackageJsonText();

		await mergeProjectCommands(
			projectDir,
			[itemWithCommands({ test: "vitest" })],
			false,
		);

		expect(promptsMocks.confirmInput).not.toHaveBeenCalled();
		expect(readPackageJsonText()).toBe(originalText);
	});

	test("it should reject when package.json is missing because npm commands are meaningless without it", async () => {
		await expect(
			mergeProjectCommands(projectDir, [
				itemWithCommands({ format: "prettier --write ." }),
			]),
		).rejects.toThrow(/package\.json was not found in the project root/);
	});

	test("it should reject __proto__ script names from payloads because prototype pollution is not a script name", async () => {
		writePackageJson({ name: "app", scripts: {} });

		await expect(
			mergeProjectCommands(projectDir, [
				itemWithCommands({ ["__proto__"]: "console.log(1)" }),
			]),
		).rejects.toThrow(/is not allowed/);
	});

	test("it should reject a non-object scripts field in package.json because a malformed manifest must not be silently rewritten", async () => {
		writePackageJson({ name: "app", scripts: "nope" });

		await expect(
			mergeProjectCommands(projectDir, [
				itemWithCommands({ format: "prettier --write ." }),
			]),
		).rejects.toThrow(/package\.json scripts must be an object/);
	});
});

import { spawnSync } from "node:child_process";

describe("packages special-node and guard branches", () => {
	function writePackageJson(value: unknown): void {
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			`${JSON.stringify(value, null, 2)}\n`,
		);
	}

	function readPackageJsonText(): string {
		return fs.readFileSync(path.join(projectDir, "package.json"), "utf8");
	}

	function itemWithCommands(commands: Record<string, string>): CompiledItem {
		return compiledItem({ files: [], commands: { npm: commands } });
	}

	test("it should reject a declared package manager outside the ecosystem because mismatched managers cannot build install commands", async () => {
		await expect(
			installDeclaredPackages(
				[{ npm: { runtime: ["zod"] } }],
				projectDir,
				"bogus" as never,
			),
		).rejects.toThrow(
			'Cannot install npm packages with package manager "bogus".',
		);
	});

	test("it should reject when the project directory exists as a file because installing packages there cannot work", async () => {
		const filePath = path.join(projectDir, "..", "packages-test-file-blocker");
		fs.writeFileSync(filePath, "not a directory");
		try {
			await expect(
				installDeclaredPackages(
					[{ npm: { runtime: ["zod"] } }],
					filePath,
					NpmPackageManager.PNPM,
				),
			).rejects.toThrow(/project directory exists and is a file/);
		} finally {
			fs.rmSync(filePath, { force: true });
		}
	});

	test("it should reject a symlinked package.json because a symlinked manifest could silently point elsewhere", async () => {
		fs.symlinkSync(
			path.join(projectDir, "elsewhere.json"),
			path.join(projectDir, "package.json"),
			"file",
		);
		await expect(
			mergeProjectCommands(projectDir, [itemWithCommands({ build: "tsc" })]),
		).rejects.toThrow(/exists and is a symbolic link/);
	});

	test("it should reject a directory at package.json because a directory cannot be merged as a manifest", async () => {
		fs.mkdirSync(path.join(projectDir, "package.json"));
		await expect(
			mergeProjectCommands(projectDir, [itemWithCommands({ build: "tsc" })]),
		).rejects.toThrow(/exists and is a directory/);
	});

	test("it should rethrow a non-missing lstat failure on package.json because a read-protected manifest must surface its own error", async () => {
		writePackageJson({ name: "app", scripts: {} });
		const realLstat = fs.promises.lstat.bind(fs.promises);
		const target = path.join(projectDir, "package.json");
		const lstatSpy = vi
			.spyOn(fs.promises, "lstat")
			.mockImplementation(async (entry: fs.PathLike) => {
				if (entry === target)
					throw Object.assign(new Error("denied"), { code: "EACCES" });
				return realLstat(entry);
			});
		try {
			await expect(
				mergeProjectCommands(projectDir, [itemWithCommands({ build: "tsc" })]),
			).rejects.toMatchObject({ code: "EACCES" });
		} finally {
			lstatSpy.mockRestore();
		}
	});

	test.skipIf(process.platform === "win32")(
		"it should reject a special node at package.json because a FIFO manifest can never be read",
		async () => {
			const fifo = path.join(projectDir, "package.json");
			const { status, stderr } = spawnSync("mkfifo", [fifo]);
			if (status !== 0)
				throw new Error(`mkfifo failed: ${stderr?.toString().trim()}`);

			await expect(
				mergeProjectCommands(projectDir, [itemWithCommands({ build: "tsc" })]),
			).rejects.toThrow(/exists but is neither a file nor a directory/);
		},
	);

	test("it should list every differing script and ask once for the batch because per-script prompts are noisy", async () => {
		writePackageJson({
			name: "app",
			scripts: { test: "vitest", lint: "eslint ." },
		});
		promptsMocks.confirmInput.mockResolvedValue(true);

		await mergeProjectCommands(
			projectDir,
			[itemWithCommands({ test: "vitest run", lint: "eslint --fix ." })],
			false,
		);

		expect(promptsMocks.confirmInput).toHaveBeenCalledTimes(1);
		expect(promptsMocks.confirmInput).toHaveBeenCalledWith(
			"Overwrite these package.json scripts?",
			{},
			false,
		);
		const packageJson = JSON.parse(readPackageJsonText()) as {
			scripts: Record<string, string>;
		};
		expect(packageJson.scripts.test).toBe("vitest run");
		expect(packageJson.scripts.lint).toBe("eslint --fix .");
	});
});

describe("packages manifest validation branches", () => {
	function writePackageJsonRaw(text: string): void {
		fs.writeFileSync(path.join(projectDir, "package.json"), text);
	}

	function itemWithCommands(commands: Record<string, string>): CompiledItem {
		return compiledItem({ files: [], commands: { npm: commands } });
	}

	test("it should run dev-only dependency installs because an empty runtime list must not suppress the dev command", async () => {
		await installDeclaredPackages(
			[{ npm: { dev: ["vitest"] } }],
			projectDir,
			NpmPackageManager.PNPM,
		);

		expect(shellMocks.runArgvAsync).toHaveBeenCalledTimes(1);
		expect(shellMocks.runArgvAsync).toHaveBeenCalledWith(
			"pnpm",
			["add", "--ignore-scripts", "-D", "vitest"],
			{ cwd: projectDir, stdio: "inherit" },
		);
	});

	test("it should install nothing when a payload declares empty dependency lists because declared-but-empty must not reach the install prompt", async () => {
		await expect(
			installDeclaredPackages(
				[{ npm: { runtime: [], dev: [] } }],
				projectDir,
				NpmPackageManager.PNPM,
			),
		).resolves.toEqual([]);

		expect(promptsMocks.confirmInput).not.toHaveBeenCalled();
		expect(shellMocks.runArgvAsync).not.toHaveBeenCalled();
	});

	test("it should return without touching the project when no compiled item declares commands because command merging is then a no-op", async () => {
		await expect(
			mergeProjectCommands(projectDir, [compiledItem({ files: [] })]),
		).resolves.toBeUndefined();

		expect(fs.existsSync(path.join(projectDir, "package.json"))).toBe(false);
		expect(promptsMocks.confirmInput).not.toHaveBeenCalled();
	});

	test("it should add payload scripts when package.json omits the scripts field because an absent map behaves like an empty one", async () => {
		writePackageJsonRaw('{"name":"app"}');

		await mergeProjectCommands(projectDir, [
			itemWithCommands({ format: "prettier --write ." }),
		]);

		const packageJson = JSON.parse(
			fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		expect(packageJson.scripts).toEqual({ format: "prettier --write ." });
		expect(promptsMocks.confirmInput).not.toHaveBeenCalled();
	});

	test("it should reject a non-object package.json document because a malformed manifest must never be rewritten", async () => {
		writePackageJsonRaw("null");

		await expect(
			mergeProjectCommands(projectDir, [itemWithCommands({ build: "tsc" })]),
		).rejects.toThrow("package.json must be a JSON object.");
	});

	test("it should reject a null scripts field because scripts must be a map before any merge", async () => {
		writePackageJsonRaw('{"name":"app","scripts":null}');

		await expect(
			mergeProjectCommands(projectDir, [itemWithCommands({ build: "tsc" })]),
		).rejects.toThrow("package.json scripts must be an object.");
	});

	test("it should reject a non-string script command in package.json because a numeric command cannot be run", async () => {
		writePackageJsonRaw('{"name":"app","scripts":{"build":42}}');

		await expect(
			mergeProjectCommands(projectDir, [itemWithCommands({ build: "tsc" })]),
		).rejects.toThrow('package.json script "build" must be a string.');
	});

	test("it should reject an empty script name in package.json because an empty name is unrunnable", async () => {
		writePackageJsonRaw('{"name":"app","scripts":{"":"x"}}');

		await expect(
			mergeProjectCommands(projectDir, [itemWithCommands({ build: "tsc" })]),
		).rejects.toThrow("package.json script name must not be empty.");
	});

	test("it should reject a __proto__ script name in package.json because prototype pollution cannot enter through the manifest either", async () => {
		writePackageJsonRaw('{"name":"app","scripts":{"__proto__":"x"}}');

		await expect(
			mergeProjectCommands(projectDir, [itemWithCommands({ build: "tsc" })]),
		).rejects.toThrow('package.json script "__proto__" is not allowed.');
	});
});
