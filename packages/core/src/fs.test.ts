import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	InvalidJsonError,
	isDirectoryAsync,
	isFileAsync,
	lstatAsync,
	PathKind,
	pathKindAsync,
	readDirectoryFilesAsync,
	readJsonFileAsync,
	removeAsync,
	writeFileAsync,
} from "./fs";

/** Mocked node:fs/promises seam for simulating non-ENOENT stat failures. */
const fsMocks = vi.hoisted(() => ({
	stat: vi.fn(),
	lstat: vi.fn(),
	actual: undefined as typeof import("node:fs/promises") | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	fsMocks.actual = actual;
	fsMocks.stat.mockImplementation(actual.stat);
	fsMocks.lstat.mockImplementation(actual.lstat);
	const patched = { ...actual, stat: fsMocks.stat, lstat: fsMocks.lstat };
	// fs.ts uses the default import, so the default export must carry the patch too.
	return { ...actual, ...patched, default: patched };
});

describe("fs temp workspace", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipebook-fs-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("readJsonFileAsync", () => {
		test("it should throw InvalidJsonError with the label and cause for a file containing invalid JSON because the caller needs to know which document broke", async () => {
			const filePath = path.join(tmpDir, "bad.json");
			fs.writeFileSync(filePath, "{oops", "utf8");

			const error = await readJsonFileAsync(filePath, "My label").then(
				() => null,
				(e) => e,
			);

			expect(error).toBeInstanceOf(InvalidJsonError);
			expect((error as Error).name).toBe("InvalidJsonError");
			expect((error as Error).message).toContain("My label");
			expect((error as Error).message).toContain("in JSON at position");
			expect((error as InvalidJsonError).cause).toBeInstanceOf(SyntaxError);
		});

		test("it should propagate the raw ENOENT error for a missing JSON file because wrapping would hide the actionable filesystem error", async () => {
			const error = await readJsonFileAsync(
				path.join(tmpDir, "missing.json"),
				"My label",
			).then(
				() => null,
				(e) => e,
			);

			expect(error).not.toBeInstanceOf(InvalidJsonError);
			expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
		});
	});

	describe("writeFileAsync", () => {
		test("it should create nested parent directories and write exact utf8 content because callers must not pre-mkdir", async () => {
			const filePath = path.join(tmpDir, "a", "b", "c.txt");
			await writeFileAsync(filePath, "hi");
			expect(fs.readFileSync(filePath, "utf8")).toBe("hi");
		});

		test("it should overwrite an existing file entirely because partial writes must never accumulate", async () => {
			const filePath = path.join(tmpDir, "over.txt");
			await writeFileAsync(filePath, "first");
			await writeFileAsync(filePath, "second");
			expect(fs.readFileSync(filePath, "utf8")).toBe("second");
		});

		test("it should propagate the mkdir error when a parent segment is an existing file because silently skipping a write risks data loss", async () => {
			const blocker = path.join(tmpDir, "f");
			fs.writeFileSync(blocker, "not a directory", "utf8");

			const error = await writeFileAsync(
				path.join(blocker, "inner.txt"),
				"data",
			).then(
				() => null,
				(e) => e,
			);

			expect(error).toBeInstanceOf(Error);
			// Node's recursive mkdir fails an existing FILE parent with EEXIST here;
			// nested-segment failures report ENOTDIR. Either way the error must
			// propagate — silently skipping the write is the data-loss bug.
			expect(["EEXIST", "ENOTDIR"]).toContain(
				(error as NodeJS.ErrnoException).code,
			);
		});
	});

	describe("removeAsync", () => {
		test("it should resolve removeAsync for a missing path because cleanup must be idempotent", async () => {
			await expect(
				removeAsync(path.join(tmpDir, "nonexistent")),
			).resolves.toBeUndefined();
		});

		test("it should remove files and nested directory trees recursively because partial cleanup would corrupt rebuilds", async () => {
			const nested = path.join(tmpDir, "tree", "deep");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(nested, "leaf.txt"), "x", "utf8");
			const plain = path.join(tmpDir, "plain.txt");
			fs.writeFileSync(plain, "x", "utf8");

			await removeAsync(path.join(tmpDir, "tree"));
			await removeAsync(plain);

			expect(fs.existsSync(path.join(tmpDir, "tree"))).toBe(false);
			expect(fs.existsSync(plain)).toBe(false);
		});
	});

	describe("pathKindAsync", () => {
		test("it should classify file, directory, and absent paths because kind drives branch decisions everywhere", async () => {
			const file = path.join(tmpDir, "some.txt");
			fs.writeFileSync(file, "x", "utf8");
			const dir = path.join(tmpDir, "some-dir");
			fs.mkdirSync(dir);

			await expect(pathKindAsync(file)).resolves.toBe(PathKind.FILE);
			await expect(pathKindAsync(dir)).resolves.toBe(PathKind.DIRECTORY);
			await expect(pathKindAsync(path.join(tmpDir, "absent"))).resolves.toBe(
				PathKind.ABSENT,
			);
		});

		test.skipIf(process.platform === "win32")(
			"it should throw for a special node that is neither a file nor a directory because silent misclassification would corrupt install decisions",
			async () => {
				const fifoPath = path.join(tmpDir, "pipe");
				const { status, stderr } = spawnSync("mkfifo", [fifoPath]);
				if (status !== 0)
					throw new Error(`mkfifo failed: ${stderr?.toString().trim()}`);

				await expect(pathKindAsync(fifoPath)).rejects.toThrowError(
					/Path ".*pipe" exists but is neither a file nor a directory\./,
				);
			},
		);
	});

	describe("readDirectoryFilesAsync", () => {
		test("it should list leaf files of a nested tree in deterministic sorted order excluding directories because order must be reproducible across machines", async () => {
			fs.mkdirSync(path.join(tmpDir, "sub"), { recursive: true });
			fs.writeFileSync(path.join(tmpDir, "z.txt"), "x", "utf8");
			fs.writeFileSync(path.join(tmpDir, "sub", "a.txt"), "x", "utf8");

			await expect(readDirectoryFilesAsync(tmpDir)).resolves.toEqual(
				[path.join(tmpDir, "sub", "a.txt"), path.join(tmpDir, "z.txt")].sort(
					(left, right) => left.localeCompare(right),
				),
			);
		});
	});

	describe("lstatAsync", () => {
		test("it should return undefined lstat for a missing path and stats for an existing file because absence is a normal state here", async () => {
			const file = path.join(tmpDir, "present.txt");
			fs.writeFileSync(file, "x", "utf8");

			await expect(
				lstatAsync(path.join(tmpDir, "missing")),
			).resolves.toBeUndefined();
			const stats = await lstatAsync(file);
			expect(stats?.isFile()).toBe(true);
		});
	});
});

describe("non-ENOENT rethrows", () => {
	test("it should rethrow a non-missing stat failure from pathKindAsync because only absence is a normal state", async () => {
		fsMocks.stat.mockRejectedValue(
			Object.assign(new Error("denied"), { code: "EACCES" }),
		);
		fsMocks.lstat.mockRejectedValue(
			Object.assign(new Error("denied"), { code: "EACCES" }),
		);
		await expect(pathKindAsync("/some/path")).rejects.toMatchObject({
			code: "EACCES",
		});
	});

	test("it should rethrow a non-missing lstat failure from lstatAsync because permission errors must not read as absence", async () => {
		fsMocks.lstat.mockRejectedValue(
			Object.assign(new Error("denied"), { code: "EACCES" }),
		);
		await expect(lstatAsync("/some/path")).rejects.toMatchObject({
			code: "EACCES",
		});
	});

	test("it should rethrow a non-missing stat failure from isFileAsync and isDirectoryAsync because classification must fail loudly", async () => {
		fsMocks.stat.mockRejectedValue(
			Object.assign(new Error("denied"), { code: "EACCES" }),
		);
		await expect(isFileAsync("/some/path")).rejects.toMatchObject({
			code: "EACCES",
		});
		await expect(isDirectoryAsync("/some/path")).rejects.toMatchObject({
			code: "EACCES",
		});
	});
});

describe("InvalidJsonError non-Error causes", () => {
	test("it should stringify non-Error causes because JSON readers may throw non-Error values", () => {
		expect(new InvalidJsonError("Widget", "boom").message).toBe(
			"Widget is not valid JSON: boom",
		);
	});
});
