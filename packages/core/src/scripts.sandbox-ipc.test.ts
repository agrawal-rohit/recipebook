import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadSandboxedModule } from "./scripts";
import { runAsync } from "./shell";

/**
 * The parent-side sandbox IPC protocol is exercised through the exported
 * `loadSandboxedModule` with a fake child process standing in for the sandbox
 * runner. Tests play the child side by emitting `message` events and inspect
 * the parent's responses through the captured `send` calls.
 */
const ipc = vi.hoisted(() => ({
	children: [] as Array<{
		emit: (event: string, ...args: unknown[]) => boolean;
		killed: boolean;
		connected: boolean;
		exitCode: null | number;
		signalCode: null | string;
		send: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
	}>,
}));

vi.mock("node:child_process", async () => {
	const { EventEmitter } = await import("node:events");
	return {
		spawn: vi.fn(() => {
			const child = Object.assign(new EventEmitter(), {
				killed: false,
				connected: true,
				exitCode: null,
				signalCode: null,
				send: vi.fn(),
				kill: vi.fn(function (this: {
					exitCode: null | number;
					emit: (event: string, ...args: unknown[]) => void;
				}) {
					this.exitCode = 0;
					queueMicrotask(() => this.emit("exit", 0, null));
					return true;
				}),
			});
			ipc.children.push(child);
			return child;
		}),
	};
});

// Host `run` mediation is parent-side shell execution; stub it at the IO boundary.
vi.mock("./shell", () => ({
	runAsync: vi.fn(async () => "ran"),
}));

let tempDir: string;
let runnerPath: string;

beforeEach(() => {
	vi.clearAllMocks();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipebook-sandbox-ipc-"));
	runnerPath = path.join(tempDir, "runner.cjs");
	fs.writeFileSync(runnerPath, "/* fake runner, never spawned */");
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
	delete process.env.RECIPEBOOK_TEST_SECRET_KEY;
	delete process.env.RECIPEBOOK_TEST_ACCESS_TOKEN;
	delete process.env.RECIPEBOOK_TEST_PASSWORD_SECRET;
});

/** Latest spawned fake child (probe children come first, call children last). */
function latestChild(): (typeof ipc.children)[number] {
	const child = ipc.children.at(-1);
	if (!child) throw new Error("No sandbox child was spawned.");
	return child;
}

describe("loadSandboxedModule probe handshake", () => {
	test("it should resolve a callable for a function-shaped probe result because hooks export functions", async () => {
		const scriptPath = path.join(tempDir, "hook.js");
		fs.writeFileSync(scriptPath, "module.exports = () => 1;");
		const pending = loadSandboxedModule(scriptPath, tempDir, runnerPath);
		const child = latestChild();
		expect(child.send).toHaveBeenCalledWith({
			type: "probe",
			scriptPath: fs.realpathSync(scriptPath),
		});
		child.emit("message", { type: "probe-result", shape: "function" });
		const loaded = (await pending) as unknown;
		expect(typeof loaded).toBe("function");
	});

	test("it should resolve an infer proxy for a condition-handler probe result because condition scripts export objects", async () => {
		const scriptPath = path.join(tempDir, "handler.js");
		fs.writeFileSync(scriptPath, "module.exports = { infer: () => 1 };");
		const pending = loadSandboxedModule(scriptPath, tempDir, runnerPath);
		latestChild().emit("message", {
			type: "probe-result",
			shape: "condition-handler",
		});
		const loaded = (await pending) as { infer: unknown };
		expect(typeof loaded.infer).toBe("function");
	});

	test("it should surface a failed probe result as the child's error because load failures must fail the load", async () => {
		const scriptPath = path.join(tempDir, "broken.js");
		fs.writeFileSync(scriptPath, "module.exports = () => 1;");
		const pending = loadSandboxedModule(scriptPath, tempDir, runnerPath);
		latestChild().emit("message", {
			type: "result",
			ok: false,
			error: "Cannot find module 'nope'",
		});
		await expect(pending).rejects.toThrowError("Cannot find module 'nope'");
	});

	test("it should reject an unknown probe shape because the sandbox cannot proxy exports it does not understand", async () => {
		const scriptPath = path.join(tempDir, "bad.js");
		fs.writeFileSync(scriptPath, "module.exports = {};");
		const pending = loadSandboxedModule(scriptPath, tempDir, runnerPath);
		latestChild().emit("message", { type: "probe-result", shape: "unknown" });
		await expect(pending).rejects.toThrowError(
			`Sandboxed script "${scriptPath}" must export a function or a condition handler with infer.`,
		);
	});
});

describe("loadSandboxedModule rejects malformed child IPC fail-closed", () => {
	const cases: Array<[string, unknown]> = [
		["null", null],
		["a number", 42],
		["a string", "x"],
		["an array", []],
		["an unknown message type", { type: "wat" }],
		["an invalid probe shape", { type: "probe-result", shape: "bogus" }],
		[
			"a host id that is not a safe integer",
			{ type: "host", id: 1.5, method: "readFile", args: ["x"] },
		],
		[
			"a host method outside the allow-list",
			{ type: "host", id: 1, method: "spawn", args: ["x"] },
		],
		[
			"host args that are not a string array",
			{ type: "host", id: 1, method: "readFile", args: ["x", 2] },
		],
		["a result whose ok is not boolean", { type: "result", ok: "yes" }],
		["a failed result without a string error", { type: "result", ok: false }],
	];

	test.each(
		cases,
	)("it should fail closed when the child sends %s because unvalidated IPC is an untrusted boundary", async (_label, message) => {
		const scriptPath = path.join(tempDir, "hook.js");
		fs.writeFileSync(scriptPath, "module.exports = () => 1;");
		const pending = loadSandboxedModule(scriptPath, tempDir, runnerPath);
		latestChild().emit("message", message);
		await expect(pending).rejects.toThrowError(
			"Sandboxed script child sent an invalid IPC message.",
		);
		expect(latestChild().kill).toHaveBeenCalledWith("SIGTERM");
	});
});

describe("loadSandboxedModule call flow", () => {
	/**
	 * Complete a probe, then start a call session and return its child plus
	 * promise so tests can play the child side.
	 */
	async function startCall(
		scriptBody: string,
		ctx: Record<string, unknown> = {},
	): Promise<{
		child: (typeof ipc.children)[number];
		pending: Promise<unknown>;
	}> {
		const scriptPath = path.join(tempDir, "hook.js");
		fs.writeFileSync(scriptPath, scriptBody);
		const probe = loadSandboxedModule(scriptPath, tempDir, runnerPath);
		latestChild().emit("message", { type: "probe-result", shape: "function" });
		const loaded = (await probe) as (
			ctx: Record<string, unknown>,
		) => Promise<unknown>;
		const pending = loaded(ctx);
		return { child: latestChild(), pending };
	}

	test("it should propagate a failed child result as a rejection because script errors must surface to the caller", async () => {
		const { pending } = await startCall("module.exports = () => 1;");
		latestChild().emit("message", {
			type: "result",
			ok: false,
			error: "boom",
		});
		await expect(pending).rejects.toThrowError("boom");
	});

	test("it should serialize the context by dropping functions and overriding projectDir because only JSON-safe fields cross IPC", async () => {
		const { child } = await startCall("module.exports = () => 1;", {
			fn: () => undefined,
			key: "v",
			projectDir: "/x",
		});
		expect(child.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: "call", exportPath: [] }),
		);
		const call = child.send.mock.calls.find(
			(args) => (args[0] as { type: string }).type === "call",
		)?.[0] as { context: Record<string, unknown> };
		expect(call.context).toEqual({
			key: "v",
			projectDir: fs.realpathSync(tempDir),
		});
	});

	test("it should reject a context whose __proto__ key is present because prototype pollution must not cross IPC", async () => {
		const { pending } = await startCall(
			"module.exports = () => 1;",
			JSON.parse('{"__proto__":"evil","key":"v"}') as Record<string, unknown>,
		);
		await expect(pending).rejects.toThrowError(
			'Handler context key "__proto__" is not allowed.',
		);
	});

	test("it should reject a context with an empty-string key because such keys cannot be addressed safely", async () => {
		const { pending } = await startCall(
			"module.exports = () => 1;",
			JSON.parse('{"":"v"}'),
		);
		await expect(pending).rejects.toThrowError(
			'Handler context key "" is not allowed.',
		);
	});

	test("it should mediate isFile host calls against the project directory because the child has no direct filesystem access", async () => {
		fs.writeFileSync(path.join(tempDir, "f.txt"), "hi");
		fs.mkdirSync(path.join(tempDir, "d"));
		const { child, pending } = await startCall("module.exports = () => 1;", {});
		child.emit("message", {
			type: "host",
			id: 1,
			method: "isFile",
			args: ["f.txt"],
		});
		child.emit("message", {
			type: "host",
			id: 2,
			method: "isFile",
			args: ["missing.txt"],
		});
		child.emit("message", {
			type: "host",
			id: 3,
			method: "isDirectory",
			args: ["d"],
		});
		child.emit("message", {
			type: "host",
			id: 4,
			method: "readFile",
			args: ["f.txt"],
		});
		await vi.waitFor(() => {
			expect(child.send).toHaveBeenCalledWith({
				type: "host-result",
				id: 1,
				ok: true,
				value: true,
			});
			expect(child.send).toHaveBeenCalledWith({
				type: "host-result",
				id: 2,
				ok: true,
				value: false,
			});
			expect(child.send).toHaveBeenCalledWith({
				type: "host-result",
				id: 3,
				ok: true,
				value: true,
			});
			expect(child.send).toHaveBeenCalledWith({
				type: "host-result",
				id: 4,
				ok: true,
				value: "hi",
			});
		});
		child.emit("message", { type: "result", ok: true, value: "done" });
		await pending;
	});

	test("it should mediate run host calls with a sanitized environment and log the command because command execution is privileged", async () => {
		process.env.RECIPEBOOK_TEST_SECRET_KEY = "leak-me";
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { child, pending } = await startCall(
				"module.exports = () => 1;",
				{},
			);
			child.emit("message", {
				type: "host",
				id: 1,
				method: "run",
				args: ["echo hi"],
			});
			await vi.waitFor(() => {
				expect(child.send).toHaveBeenCalledWith({
					type: "host-result",
					id: 1,
					ok: true,
					value: "ran",
				});
			});
			// Scope to the call made by this test's own temp dir, never "first call",
			// so shuffled ordering cannot leak a sibling test's invocation here.
			const call = vi
				.mocked(runAsync)
				.mock.calls.find(
					(call) =>
						(call[1] as { cwd: string }).cwd === fs.realpathSync(tempDir),
				);
			if (!call) {
				throw new Error("expected runAsync call scoped to temp dir");
			}
			const [, opts] = call;
			if (!opts) {
				throw new Error("expected runAsync options");
			}
			expect(opts.cwd).toBe(fs.realpathSync(tempDir));
			expect(opts.stdio).toBe("pipe");
			const env = opts.env;
			if (!env) {
				throw new Error("expected runAsync env");
			}
			expect(env.PATH).toBeDefined();
			expect(env.RECIPEBOOK_TEST_SECRET_KEY).toBeUndefined();
			expect(errorSpy).toHaveBeenCalledWith("[recipebook:script] run: echo hi");
			child.emit("message", { type: "result", ok: true, value: "done" });
			await pending;
		} finally {
			errorSpy.mockRestore();
		}
	});

	test("it should answer host calls with ok:false when the host helper throws because children must see failures as results", async () => {
		vi.mocked(runAsync).mockRejectedValueOnce(new Error("nope"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { child, pending } = await startCall(
				"module.exports = () => 1;",
				{},
			);
			child.emit("message", {
				type: "host",
				id: 1,
				method: "run",
				args: ["x"],
			});
			await vi.waitFor(() => {
				expect(child.send).toHaveBeenCalledWith({
					type: "host-result",
					id: 1,
					ok: false,
					error: "nope",
				});
			});
			child.emit("message", { type: "result", ok: true, value: "done" });
			await pending;
		} finally {
			errorSpy.mockRestore();
		}
	});

	test("it should fail closed on an empty host argument because malformed requests are never executed", async () => {
		const { child, pending } = await startCall("module.exports = () => 1;", {});
		child.emit("message", {
			type: "host",
			id: 1,
			method: "readFile",
			args: [],
		});
		await vi.waitFor(() => {
			const hostResult = child.send.mock.calls.find(
				(args) => (args[0] as { type: string }).type === "host-result",
			)?.[0] as { ok: boolean; error: string };
			expect(hostResult.ok).toBe(false);
			expect(hostResult.error).toContain(
				"requires a non-empty string argument.",
			);
		});
		child.emit("message", { type: "result", ok: true, value: "done" });
		await pending;
	});
});

describe("loadSandboxedModule child teardown", () => {
	test("it should SIGTERM the child after the session completes because no sandbox child may outlive its session", async () => {
		const scriptPath = path.join(tempDir, "hook.js");
		fs.writeFileSync(scriptPath, "module.exports = () => 1;");
		const pending = loadSandboxedModule(scriptPath, tempDir, runnerPath);
		latestChild().emit("message", { type: "probe-result", shape: "function" });
		await pending;
		expect(latestChild().kill).toHaveBeenCalledWith("SIGTERM");
	});

	test("it should complete teardown for an already-exited child because closeChild must not hang on exited children", async () => {
		const scriptPath = path.join(tempDir, "hook.js");
		fs.writeFileSync(scriptPath, "module.exports = () => 1;");
		const pending = loadSandboxedModule(scriptPath, tempDir, runnerPath);
		const child = latestChild();
		child.exitCode = 0;
		child.emit("message", { type: "probe-result", shape: "function" });
		await expect(pending).resolves.toBeTypeOf("function");
	});
});
