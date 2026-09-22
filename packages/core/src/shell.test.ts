import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runArgvAsync, runAsync } from "./shell";

describe("runAsync tokenizer", () => {
	test("it should run a plain command and return trimmed stdout because token splitting is the public parse surface", async () => {
		await expect(runAsync("node -p '1 + 1'")).resolves.toBe("2");
	});

	test("it should keep a double-quoted multi-word argument as one argv token because arguments must survive without a shell", async () => {
		await expect(runAsync("node -p \"'a' + ' ' + 'b'\"")).resolves.toBe("a b");
	});

	test("it should pass a single-quoted argument containing spaces and an embedded double quote verbatim because single quotes must protect shell-like characters", async () => {
		await expect(runAsync(`node -p '"a b"'`)).resolves.toBe("a b");
	});

	test("it should preserve an empty quoted token because dropping it would change the argv the program receives", async () => {
		await expect(runAsync("node -e ''")).resolves.toBe("");
	});

	test("it should reject an unterminated double quote before spawning because an unterminated quote is a caller error", () => {
		// `runAsync` is not async, so tokenizer failures throw synchronously.
		expect(() => runAsync('node -p "1')).toThrowError(
			"Unterminated double quote in command",
		);
		expect(() => runAsync("node -p '1")).toThrowError(
			"Unterminated single quote in command",
		);
	});

	test("it should reject a whitespace-only command because spawning nothing would produce a confusing spawn error", () => {
		expect(() => runAsync("   ")).toThrowError("Command cannot be empty");
	});
});

describe("runAsync runner options", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheetos-shell-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("it should run the command in the requested cwd because cwd must be honored without a shell", async () => {
		// `pwd` prints the physical (symlink-resolved) directory.
		await expect(runAsync("pwd", { cwd: tmpDir })).resolves.toBe(
			fs.realpathSync(tmpDir),
		);
	});

	test("it should merge custom env over process.env because PATH must survive custom envs", async () => {
		await expect(
			runAsync("node -p process.env.CHEETOS_TEST", {
				env: { CHEETOS_TEST: "bar" },
			}),
		).resolves.toBe("bar");
	});

	test("it should reject a non-zero exit with the exit code and trimmed stderr because failures must be actionable", async () => {
		await expect(
			runAsync("node -e \"console.error('boom'); process.exit(3)\""),
		).rejects.toThrowError(/Command failed: node -e .* \(exit 3\): boom/u);
	});

	test("it should reject a timed-out command with the timeout in the message because a silent SIGTERM would be undiagnosable", async () => {
		await expect(runAsync("sleep 5", { timeoutMs: 100 })).rejects.toThrowError(
			"Command failed: sleep 5 (timed out after 100ms)",
		);
	});

	test("it should reject a command that cannot start with the display label and cause because ENOENT must name the missing binary", async () => {
		const error = await runAsync("definitely-not-a-binary-xyz").then(
			() => null,
			(e) => e,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			"Failed to start command: definitely-not-a-binary-xyz:",
		);
		expect(
			(error as Error & { cause?: NodeJS.ErrnoException }).cause?.code,
		).toBe("ENOENT");
	});

	test("it should resolve to empty stdout for non-pipe stdio because nothing is captured by design", async () => {
		await expect(
			runAsync("node -e 'process.exit(0)'", { stdio: "ignore" }),
		).resolves.toBe("");
	});
});

describe("runArgvAsync", () => {
	test("it should pass a space-containing arg as a single argv entry because no shell must ever re-split arguments", async () => {
		await expect(
			runArgvAsync("node", ["-p", "process.argv[1]", "a b"]),
		).resolves.toBe("a b");
	});

	test("it should use the joined argv as the failure display label because errors must name what was attempted", async () => {
		await expect(
			runArgvAsync("definitely-not-a-binary-xyz", []),
		).rejects.toThrowError(
			/Failed to start command: definitely-not-a-binary-xyz/u,
		);
	});
});
