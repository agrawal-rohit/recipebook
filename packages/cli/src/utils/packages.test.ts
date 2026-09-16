import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	InvalidJsonError,
	NpmPackageManager,
	RegistryDependencyKind,
	type RegistryEcosystemDependencies,
} from "@pebbles/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConfirmInput = vi.fn();
const mockSelectInput = vi.fn();
const mockRunArgvAsync = vi.fn();
const mockRunWithTasks = vi.fn();
const mockBuildPackageInstallCommands = vi.fn();
const mockMergeEcosystemMaps = vi.fn();
const mockIsPackageManagerForEcosystem = vi.fn();

vi.mock("../cli/prompts", () => ({
	confirmInput: (...args: unknown[]) => mockConfirmInput(...args),
	selectInput: (...args: unknown[]) => mockSelectInput(...args),
}));

vi.mock("../cli/tasks", () => ({
	runWithTasks: (...args: unknown[]) => mockRunWithTasks(...args),
}));

vi.mock("@pebbles/core", async () => {
	const actual =
		await vi.importActual<typeof import("@pebbles/core")>("@pebbles/core");
	return {
		...actual,
		buildPackageInstallCommands: (...args: unknown[]) =>
			mockBuildPackageInstallCommands(...args),
		isPackageManagerForEcosystem: (...args: unknown[]) =>
			mockIsPackageManagerForEcosystem(...args),
		mergeEcosystemMaps: (...args: unknown[]) => mockMergeEcosystemMaps(...args),
		runArgvAsync: (...args: unknown[]) => mockRunArgvAsync(...args),
	};
});

import { installDeclaredPackages, mergeProjectCommands } from "./packages";

describe("utils/packages", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		mockRunWithTasks.mockImplementation(
			async (_goal: string, task?: () => Promise<void>) => {
				if (task) await task();
			},
		);
		mockBuildPackageInstallCommands.mockReturnValue([
			{
				executable: "npm",
				args: ["install", "--ignore-scripts", "-D", "vitest@^3"],
				display: "npm install --ignore-scripts -D vitest@^3",
			},
		]);
		mockMergeEcosystemMaps.mockReturnValue({
			npm: { [RegistryDependencyKind.DEV]: ["vitest@^3"] },
		} satisfies RegistryEcosystemDependencies);
		mockIsPackageManagerForEcosystem.mockReturnValue(true);
		mockConfirmInput.mockResolvedValue(true);
		mockSelectInput.mockResolvedValue(NpmPackageManager.NPM);
		mockRunArgvAsync.mockResolvedValue("");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns early when install planning yields no package names", async () => {
		mockBuildPackageInstallCommands.mockReturnValue([
			{
				executable: "npm",
				args: ["install", "--ignore-scripts"],
				display: "npm install --ignore-scripts",
			},
		]);
		mockMergeEcosystemMaps.mockReturnValue({
			npm: {
				[RegistryDependencyKind.RUNTIME]: [],
				[RegistryDependencyKind.DEV]: [],
			},
		});

		await expect(
			installDeclaredPackages(
				[{ npm: { [RegistryDependencyKind.RUNTIME]: [] } }],
				"/project",
				NpmPackageManager.NPM,
			),
		).resolves.toEqual([]);
		expect(mockConfirmInput).not.toHaveBeenCalled();
	});

	it("merges commands when package.json omits scripts", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ name: "demo" }),
			"utf8",
		);
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });

		try {
			await mergeProjectCommands(projectDir, [
				{ files: [], commands: { npm: { test: "vitest run" } } },
			]);
			const written = JSON.parse(
				await fs.promises.readFile(
					path.join(projectDir, "package.json"),
					"utf8",
				),
			) as { scripts: Record<string, string> };
			expect(written.scripts).toEqual({ test: "vitest run" });
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("rejects package.json scripts that are an array", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ scripts: [] }),
			"utf8",
		);
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });

		try {
			await expect(
				mergeProjectCommands(projectDir, [
					{ files: [], commands: { npm: { test: "vitest run" } } },
				]),
			).rejects.toThrow("package.json scripts must be an object.");
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("returns early when declarations list no package names", async () => {
		mockMergeEcosystemMaps.mockReturnValue(undefined);

		await expect(
			installDeclaredPackages(
				[{ npm: { [RegistryDependencyKind.RUNTIME]: [] } }],
				"/project",
				NpmPackageManager.NPM,
			),
		).resolves.toEqual([]);
		expect(mockConfirmInput).not.toHaveBeenCalled();
		expect(mockBuildPackageInstallCommands).not.toHaveBeenCalled();
	});

	it("installs with the selected package manager and does not prompt for a manager", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		try {
			await expect(
				installDeclaredPackages(
					[{ npm: { [RegistryDependencyKind.DEV]: ["vitest@^3"] } }],
					projectDir,
					NpmPackageManager.NPM,
				),
			).resolves.toEqual([]);

			expect(mockSelectInput).not.toHaveBeenCalled();
			expect(mockBuildPackageInstallCommands).toHaveBeenCalledWith(
				"npm",
				NpmPackageManager.NPM,
				{ [RegistryDependencyKind.DEV]: ["vitest@^3"] },
			);
			expect(mockRunArgvAsync).toHaveBeenCalledWith(
				"npm",
				["install", "--ignore-scripts", "-D", "vitest@^3"],
				expect.objectContaining({ cwd: projectDir }),
			);
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("uses the selected package manager for next-step commands when install is declined", async () => {
		mockConfirmInput.mockResolvedValue(false);
		mockBuildPackageInstallCommands.mockReturnValue([
			{
				executable: "pnpm",
				args: ["add", "--ignore-scripts", "-D", "vitest@^3"],
				display: "pnpm add --ignore-scripts -D vitest@^3",
			},
		]);

		await expect(
			installDeclaredPackages(
				[{ npm: { [RegistryDependencyKind.DEV]: ["vitest@^3"] } }],
				"/project",
				NpmPackageManager.PNPM,
			),
		).resolves.toEqual(["pnpm add --ignore-scripts -D vitest@^3"]);

		expect(mockSelectInput).not.toHaveBeenCalled();
		expect(mockBuildPackageInstallCommands).toHaveBeenCalledWith(
			"npm",
			NpmPackageManager.PNPM,
			{ [RegistryDependencyKind.DEV]: ["vitest@^3"] },
		);
		expect(mockRunArgvAsync).not.toHaveBeenCalled();
	});

	it("throws when declared packages do not match the selected package manager", async () => {
		mockIsPackageManagerForEcosystem.mockReturnValue(false);

		await expect(
			installDeclaredPackages(
				[{ npm: { [RegistryDependencyKind.DEV]: ["vitest@^3"] } }],
				"/project",
				NpmPackageManager.NPM,
			),
		).rejects.toThrow(
			'Cannot install npm packages with package manager "npm".',
		);
		expect(mockConfirmInput).not.toHaveBeenCalled();
		expect(mockRunArgvAsync).not.toHaveBeenCalled();
	});

	it("throws when the project directory is a file", async () => {
		const projectDir = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-")),
			"not-a-dir",
		);
		fs.writeFileSync(projectDir, "nope");
		try {
			await expect(
				installDeclaredPackages(
					[{ npm: { [RegistryDependencyKind.DEV]: ["vitest@^3"] } }],
					projectDir,
					NpmPackageManager.NPM,
				),
			).rejects.toThrow(
				"Cannot install packages: project directory exists and is a file.",
			);
			expect(mockRunArgvAsync).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(path.dirname(projectDir), { recursive: true, force: true });
		}
	});

	it("throws when the project directory is missing", async () => {
		await expect(
			installDeclaredPackages(
				[{ npm: { [RegistryDependencyKind.DEV]: ["vitest@^3"] } }],
				path.join(os.tmpdir(), `missing-project-${Date.now()}`),
				NpmPackageManager.NPM,
			),
		).rejects.toThrow(
			"Cannot install packages: project directory was not found.",
		);
		expect(mockRunArgvAsync).not.toHaveBeenCalled();
	});

	it("throws when npm commands are declared but package.json is missing", async () => {
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });

		await expect(
			mergeProjectCommands("/missing-project", [
				{ files: [], commands: { npm: { test: "vitest run" } } },
			]),
		).rejects.toThrow(
			"Cannot merge package.json scripts: package.json was not found in the project root.",
		);
	});

	it("skips merging when there are no npm commands", async () => {
		mockMergeEcosystemMaps.mockReturnValue(undefined);

		await expect(
			mergeProjectCommands("/project", [{ files: [] }]),
		).resolves.toBe(undefined);
	});

	it("merges new scripts and skips identical existing scripts", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ scripts: { test: "vitest run" } }),
			"utf8",
		);
		mockMergeEcosystemMaps.mockReturnValue({
			npm: { test: "vitest run", cov: "vitest run --coverage" },
		});

		try {
			await mergeProjectCommands(projectDir, [
				{
					files: [],
					commands: {
						npm: { test: "vitest run", cov: "vitest run --coverage" },
					},
				},
			]);
			const written = JSON.parse(
				fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
			) as { scripts: Record<string, string> };
			expect(written.scripts).toEqual({
				test: "vitest run",
				cov: "vitest run --coverage",
			});
			expect(mockConfirmInput).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("overwrites an existing script when confirmed", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ scripts: { test: "jest" } }),
			"utf8",
		);
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });
		mockConfirmInput.mockResolvedValue(true);

		try {
			await mergeProjectCommands(projectDir, [
				{ files: [], commands: { npm: { test: "vitest run" } } },
			]);
			const written = JSON.parse(
				fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
			) as { scripts: Record<string, string> };
			expect(written.scripts).toEqual({ test: "vitest run" });
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("keeps an existing script when overwrite is declined", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ scripts: { test: "jest" } }),
			"utf8",
		);
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });
		mockConfirmInput.mockResolvedValue(false);

		try {
			await mergeProjectCommands(projectDir, [
				{ files: [], commands: { npm: { test: "vitest run" } } },
			]);
			const written = JSON.parse(
				fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
			) as { scripts: Record<string, string> };
			expect(written.scripts).toEqual({ test: "jest" });
			expect(
				fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
			).toBe(JSON.stringify({ scripts: { test: "jest" } }));
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("prompts once for several script replacements", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ scripts: { test: "jest", lint: "eslint" } }),
			"utf8",
		);
		mockMergeEcosystemMaps.mockReturnValue({
			npm: { test: "vitest run", lint: "biome check" },
		});
		mockConfirmInput.mockResolvedValue(true);

		try {
			await mergeProjectCommands(projectDir, [
				{
					files: [],
					commands: {
						npm: { test: "vitest run", lint: "biome check" },
					},
				},
			]);
			expect(mockConfirmInput).toHaveBeenCalledTimes(1);
			expect(mockConfirmInput).toHaveBeenCalledWith(
				"Overwrite these package.json scripts?",
				{},
				false,
			);
			const written = JSON.parse(
				fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
			) as { scripts: Record<string, string> };
			expect(written.scripts).toEqual({
				test: "vitest run",
				lint: "biome check",
			});
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("skips replacement prompts when overwrite is true", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ scripts: { test: "jest" } }),
			"utf8",
		);
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });

		try {
			await mergeProjectCommands(
				projectDir,
				[{ files: [], commands: { npm: { test: "vitest run" } } }],
				true,
			);
			expect(mockConfirmInput).not.toHaveBeenCalled();
			const written = JSON.parse(
				fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
			) as { scripts: Record<string, string> };
			expect(written.scripts).toEqual({ test: "vitest run" });
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("does not rewrite package.json when every script already matches", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		const original = JSON.stringify({ scripts: { test: "vitest run" } });
		fs.writeFileSync(path.join(projectDir, "package.json"), original, "utf8");
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });

		try {
			await mergeProjectCommands(projectDir, [
				{ files: [], commands: { npm: { test: "vitest run" } } },
			]);
			expect(
				fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
			).toBe(original);
			expect(mockConfirmInput).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("adds new scripts when replacements are declined", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ scripts: { test: "jest" } }),
			"utf8",
		);
		mockMergeEcosystemMaps.mockReturnValue({
			npm: { test: "vitest run", cov: "vitest run --coverage" },
		});
		mockConfirmInput.mockResolvedValue(false);

		try {
			await mergeProjectCommands(projectDir, [
				{
					files: [],
					commands: {
						npm: { test: "vitest run", cov: "vitest run --coverage" },
					},
				},
			]);
			const written = JSON.parse(
				fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
			) as { scripts: Record<string, string> };
			expect(written.scripts).toEqual({
				test: "jest",
				cov: "vitest run --coverage",
			});
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("rejects invalid package.json with a labeled JSON error", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(path.join(projectDir, "package.json"), "{", "utf8");
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });

		try {
			await expect(
				mergeProjectCommands(projectDir, [
					{ files: [], commands: { npm: { test: "vitest run" } } },
				]),
			).rejects.toBeInstanceOf(InvalidJsonError);
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("rejects package.json that exists as a directory", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.mkdirSync(path.join(projectDir, "package.json"));
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });

		try {
			await expect(
				mergeProjectCommands(projectDir, [
					{ files: [], commands: { npm: { test: "vitest run" } } },
				]),
			).rejects.toThrow("exists and is a directory");
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("rejects package.json that is a symbolic link", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		const realPackageJson = path.join(projectDir, "real-package.json");
		fs.writeFileSync(realPackageJson, JSON.stringify({ scripts: {} }), "utf8");
		fs.symlinkSync(realPackageJson, path.join(projectDir, "package.json"));
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });

		try {
			await expect(
				mergeProjectCommands(projectDir, [
					{ files: [], commands: { npm: { test: "vitest run" } } },
				]),
			).rejects.toThrow("exists and is a symbolic link");
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("rejects package.json that is neither a file nor a directory", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });
		vi.spyOn(fs.promises, "lstat").mockResolvedValueOnce({
			isSymbolicLink: () => false,
			isDirectory: () => false,
			isFile: () => false,
		} as fs.Stats);

		try {
			await expect(
				mergeProjectCommands(projectDir, [
					{ files: [], commands: { npm: { test: "vitest run" } } },
				]),
			).rejects.toThrow("exists but is neither a file nor a directory");
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("rethrows unexpected package.json lstat errors", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		const error = Object.assign(new Error("permission denied"), {
			code: "EACCES",
		});
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });
		vi.spyOn(fs.promises, "lstat").mockRejectedValueOnce(error);

		try {
			await expect(
				mergeProjectCommands(projectDir, [
					{ files: [], commands: { npm: { test: "vitest run" } } },
				]),
			).rejects.toBe(error);
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("rejects a non-object package.json document", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(path.join(projectDir, "package.json"), "[]", "utf8");
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });

		try {
			await expect(
				mergeProjectCommands(projectDir, [
					{ files: [], commands: { npm: { test: "vitest run" } } },
				]),
			).rejects.toThrow("package.json must be a JSON object.");
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("rejects a non-string package.json script value", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ scripts: { test: ["vitest"] } }),
			"utf8",
		);
		mockMergeEcosystemMaps.mockReturnValue({ npm: { test: "vitest run" } });

		try {
			await expect(
				mergeProjectCommands(projectDir, [
					{ files: [], commands: { npm: { test: "vitest run" } } },
				]),
			).rejects.toThrow('package.json script "test" must be a string.');
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("rejects an empty package.json script name", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ scripts: {} }),
			"utf8",
		);
		mockMergeEcosystemMaps.mockReturnValue({ npm: { "": "echo hi" } });

		try {
			await expect(
				mergeProjectCommands(projectDir, [
					{ files: [], commands: { npm: { "": "echo hi" } } },
				]),
			).rejects.toThrow("package.json script name must not be empty.");
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("rejects a __proto__ package.json script name", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-packages-"));
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ scripts: {} }),
			"utf8",
		);
		const npmCommands = Object.create(null) as Record<string, string>;
		Object.defineProperty(npmCommands, "__proto__", {
			value: "echo pwned",
			enumerable: true,
			configurable: true,
			writable: true,
		});
		mockMergeEcosystemMaps.mockReturnValue({ npm: npmCommands });

		try {
			await expect(
				mergeProjectCommands(projectDir, [
					{ files: [], commands: { npm: npmCommands } },
				]),
			).rejects.toThrow('package.json script "__proto__" is not allowed.');
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});
});
