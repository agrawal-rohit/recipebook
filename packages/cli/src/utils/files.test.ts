import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type CompiledItem,
	type CompiledItemFile,
	compiledItem,
} from "@recipebook/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	confirmFileOverwrites,
	planFileWrites,
	writePlannedFile,
} from "./files";

const promptsMocks = vi.hoisted(() => ({
	confirmInput: vi.fn(),
}));
vi.mock("../cli/prompts/confirm", () => ({
	confirmInput: promptsMocks.confirmInput,
}));

/** Prepared install item fixture wrapping a compiled payload. */
function item(
	label: string,
	files: CompiledItemFile[],
): {
	label: string;
	compiledItem: CompiledItem;
} {
	return { label, compiledItem: compiledItem({ files }) };
}

let projectDir: string;

beforeEach(() => {
	promptsMocks.confirmInput.mockReset();
	projectDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "recipebook-files-")),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("planFileWrites", () => {
	test("it should plan jailed destinations and report no conflicts for untouched targets because new files should write straight through", async () => {
		const plan = await planFileWrites(projectDir, [
			item("Button", [{ target: "src/button.ts", content: "button" }]),
		]);

		expect(plan.conflicts).toEqual([]);
		expect(plan.items).toEqual([
			{
				label: "Button",
				files: [
					{
						target: "src/button.ts",
						destination: path.join(projectDir, "src/button.ts"),
						content: "button",
						projectDir,
					},
				],
			},
		]);
	});

	test("it should list existing files as conflicts because the user must confirm replacing them", async () => {
		fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, "src/button.ts"), "old");

		const plan = await planFileWrites(projectDir, [
			item("Button", [{ target: "src/button.ts", content: "new" }]),
		]);

		expect(plan.conflicts).toEqual(["src/button.ts"]);
	});

	test("it should reject two payloads claiming the same target because a later write would silently overwrite the earlier one", async () => {
		await expect(
			planFileWrites(projectDir, [
				item("Button", [{ target: "shared.txt", content: "a" }]),
				item("Label", [{ target: "shared.txt", content: "b" }]),
			]),
		).rejects.toThrow(/Multiple compiled items write to the same target/);
	});

	test.skipIf(process.platform === "win32")(
		"it should reject a destination that is a special node because a FIFO target can never hold file content",
		async () => {
			fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
			const fifo = path.join(projectDir, "src/button.ts");
			const { status, stderr } = spawnSync("mkfifo", [fifo]);
			if (status !== 0)
				throw new Error(`mkfifo failed: ${stderr?.toString().trim()}`);

			await expect(
				planFileWrites(projectDir, [
					item("Button", [{ target: "src/button.ts", content: "new" }]),
				]),
			).rejects.toThrow(
				'Compiled item file target "src/button.ts" exists but is neither a file nor a directory.',
			);
		},
	);

	test("it should rethrow a non-missing lstat failure during planning because only a missing destination counts as absent", async () => {
		const destination = path.join(projectDir, "src/button.ts");
		const realLstat = fs.promises.lstat.bind(fs.promises);
		const lstatSpy = vi
			.spyOn(fs.promises, "lstat")
			// The destination check runs after the ancestor walk; reject only there.
			.mockImplementation(async (entry: fs.PathLike) => {
				if (entry === destination)
					throw Object.assign(new Error("denied"), { code: "EACCES" });
				return realLstat(entry);
			});
		try {
			await expect(
				planFileWrites(projectDir, [
					item("Button", [{ target: "src/button.ts", content: "new" }]),
				]),
			).rejects.toMatchObject({ code: "EACCES" });
		} finally {
			lstatSpy.mockRestore();
		}
	});

	test("it should reject targets escaping the project root because writes must stay jailed under the project directory", async () => {
		await expect(
			planFileWrites(projectDir, [
				item("Button", [{ target: "../escape.txt", content: "x" }]),
			]),
		).rejects.toThrow(/must be a relative path under the project directory/);
	});

	test("it should reject a destination whose ancestor path is a symbolic link because the write could land outside the project", async () => {
		const outside = fs.mkdtempSync(
			path.join(os.tmpdir(), "recipebook-files-outside-"),
		);
		fs.symlinkSync(outside, path.join(projectDir, "link"));

		try {
			await expect(
				planFileWrites(projectDir, [
					item("Button", [{ target: "link/new.txt", content: "x" }]),
				]),
			).rejects.toThrow(/path includes a symbolic link/);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test("it should reject an existing directory at the destination because overwriting it would destroy the files inside", async () => {
		fs.mkdirSync(path.join(projectDir, "src/button.ts"), {
			recursive: true,
		});

		await expect(
			planFileWrites(projectDir, [
				item("Button", [{ target: "src/button.ts", content: "x" }]),
			]),
		).rejects.toThrow(/exists and is a directory/);
	});

	test("it should reject an existing symbolic link at the destination because the write must not follow it", async () => {
		fs.symlinkSync(
			path.join(projectDir, "elsewhere.txt"),
			path.join(projectDir, "button.txt"),
		);

		await expect(
			planFileWrites(projectDir, [
				item("Button", [{ target: "button.txt", content: "x" }]),
			]),
		).rejects.toThrow(/exists and is a symbolic link/);
	});
});

describe("writePlannedFile", () => {
	test("it should write the planned content at the planned destination because that is the only effect of installing files", async () => {
		const destination = path.join(projectDir, "src/button.ts");

		await writePlannedFile({
			target: "src/button.ts",
			destination,
			content: "button",
			projectDir,
		});

		expect(fs.readFileSync(destination, "utf8")).toBe("button");
	});

	test("it should re-reject a symlink ancestor that appeared after planning because the planning-time jail is not enough on its own", async () => {
		const outside = fs.mkdtempSync(
			path.join(os.tmpdir(), "recipebook-files-outside-"),
		);
		const destination = path.join(projectDir, "link/new.txt");

		try {
			// The ancestor symlink is created between planning and writing.
			fs.symlinkSync(outside, path.join(projectDir, "link"));

			await expect(
				writePlannedFile({
					target: "link/new.txt",
					destination,
					content: "x",
					projectDir,
				}),
			).rejects.toThrow(/path includes a symbolic link/);
			expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test("it should overwrite an existing file because the write-time re-check only guards new jail escapes, not confirmed replacements", async () => {
		const destination = path.join(projectDir, "button.txt");
		fs.writeFileSync(destination, "old");

		await writePlannedFile({
			target: "button.txt",
			destination,
			content: "new",
			projectDir,
		});

		expect(fs.readFileSync(destination, "utf8")).toBe("new");
	});
});

describe("confirmFileOverwrites", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	test("it should skip prompting when overwriting is forced or no targets conflict because there is nothing to confirm", async () => {
		await confirmFileOverwrites(["a.txt"], true);
		await confirmFileOverwrites([], false);

		expect(promptsMocks.confirmInput).not.toHaveBeenCalled();
	});

	test("it should ask once per single conflict and cancel when the user declines because overwriting user files needs explicit consent", async () => {
		promptsMocks.confirmInput.mockResolvedValue(false);

		await expect(
			confirmFileOverwrites(["src/button.ts"], false),
		).rejects.toThrow(/Installation canceled before overwriting/);

		expect(promptsMocks.confirmInput).toHaveBeenCalledTimes(1);
		expect(promptsMocks.confirmInput).toHaveBeenCalledWith(
			expect.stringContaining("src/button.ts"),
			{},
			false,
		);
	});

	test("it should resolve when the user accepts the single overwrite because consent was given", async () => {
		promptsMocks.confirmInput.mockResolvedValue(true);

		await expect(
			confirmFileOverwrites(["src/button.ts"], false),
		).resolves.toBeUndefined();
	});

	test("it should list every conflicting target and ask once for all of them because interrupting per file is noisy", async () => {
		const logOutput: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map((arg) => String(arg)).join(" "));
		});
		promptsMocks.confirmInput.mockResolvedValue(true);

		await confirmFileOverwrites(["a.txt", "b.txt"], false);

		expect(logOutput).toEqual(
			expect.arrayContaining([
				expect.stringContaining("The following files already exist:"),
				expect.stringContaining("a.txt"),
				expect.stringContaining("b.txt"),
			]),
		);
		expect(promptsMocks.confirmInput).toHaveBeenCalledTimes(1);
		expect(promptsMocks.confirmInput).toHaveBeenCalledWith(
			"Overwrite these files?",
			{},
			false,
		);
	});

	test("it should cancel the whole install when the user declines the multi-file prompt because partial overwrites are not consent", async () => {
		promptsMocks.confirmInput.mockResolvedValue(false);

		await expect(
			confirmFileOverwrites(["a.txt", "b.txt"], false),
		).rejects.toThrow(
			/Installation canceled before overwriting existing files/,
		);
	});
});
