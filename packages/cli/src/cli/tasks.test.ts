import { describe, expect, test, vi } from "vitest";
import { runWithTasks, task, taskGroup } from "./tasks";

/**
 * Force `process.stdout.isTTY` and capture stdout writes while `fn` runs.
 * Restores both in `finally` so later tests see the real stream.
 */
async function withCapturedStdout(
	isTTY: boolean | undefined,
	fn: () => Promise<void>,
): Promise<{ out: string; error: unknown }> {
	const prior = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", {
		configurable: true,
		enumerable: true,
		value: isTTY,
		writable: true,
	});
	let out = "";
	const write = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	}) as typeof process.stdout.write;
	let error: unknown;
	try {
		await fn();
	} catch (caught) {
		error = caught;
	} finally {
		process.stdout.write = write;
		if (prior) Object.defineProperty(process.stdout, "isTTY", prior);
		else Reflect.deleteProperty(process.stdout, "isTTY");
	}
	return { out, error };
}

describe("taskGroup construction", () => {
	test("it should reject an empty group synchronously because a group without work is a caller bug, not a runtime condition", () => {
		expect(() => taskGroup("g", [])).toThrowError(
			'Task group "g" has no work.',
		);
	});

	test("it should build a runnable group node from a non-empty subtask list because taskGroup is the only sanctioned group constructor", () => {
		const child = task("a", async () => {});
		const group = taskGroup("g", [child]);
		expect(group).toEqual({ title: "g", subtasks: [child] });
	});
});

describe("runWithTasks", () => {
	test("it should reject an empty subtask list because running nothing must fail loudly, not silently succeed", async () => {
		await expect(runWithTasks("t", [])).rejects.toThrowError(
			'Task "t" has no work.',
		);
	});

	test("it should run a single work function exactly once because runWithTasks is the standard execution wrapper", async () => {
		const fn = vi.fn(async () => {});
		await expect(runWithTasks("t", fn)).resolves.toBeUndefined();
		expect(fn).toHaveBeenCalledTimes(1);
	});

	test("it should reject when the single work function fails because a failed goal must not be reported as success", async () => {
		const fn = vi.fn(async () => {
			throw new Error("sentinel-task-failure");
		});
		await expect(runWithTasks("t", fn)).rejects.toThrowError(
			/sentinel-task-failure/u,
		);
	});

	test("it should run every subtask because each declared unit of work must execute", async () => {
		const fnA = vi.fn(async () => {});
		const fnB = vi.fn(async () => {});
		await expect(
			runWithTasks("t", [task("a", fnA), task("b", fnB)]),
		).resolves.toBeUndefined();
		expect(fnA).toHaveBeenCalledTimes(1);
		expect(fnB).toHaveBeenCalledTimes(1);
	});

	test("it should run nested groups, group hook first, because a group is a unit whose own work precedes its children", async () => {
		const calls: string[] = [];
		// `taskGroup` cannot attach its own work, so the group node is built directly
		// to exercise the `task` + `subtasks` combination in `toListrTasks`.
		await expect(
			runWithTasks("t", [
				{
					title: "g",
					task: async () => {
						calls.push("hook");
					},
					subtasks: [
						task("a", async () => {
							calls.push("child");
						}),
					],
				},
			]),
		).resolves.toBeUndefined();
		expect(calls).toEqual(["hook", "child"]);
	});

	test("it should run a real taskGroup node without its own task because a group that only groups children must not attempt to invoke a missing hook", async () => {
		// Exercises the production `taskGroup` shape: `task` is undefined, so the
		// `if (subtask.task)` guard must skip the hook instead of calling it.
		const fnA = vi.fn(async () => {});
		await expect(
			runWithTasks("t", [taskGroup("g", [task("a", fnA)])]),
		).resolves.toBeUndefined();
		expect(fnA).toHaveBeenCalledTimes(1);
	});

	test("it should reject when one subtask fails because a failed subtask must fail the whole run", async () => {
		const boom = new Error("sentinel-task-failure");
		await expect(
			runWithTasks("t", [
				task("ok", async () => {}),
				task("bad", async () => {
					throw boom;
				}),
			]),
		).rejects.toThrowError(/sentinel-task-failure/u);
	});

	test("it should reject a subtask with no task and no subtasks because a declared-but-empty subtask is a registry authoring bug", async () => {
		await expect(
			runWithTasks("t", [{ title: "x" } as never]),
		).rejects.toThrowError('Subtask "x" has no work.');
	});
});

describe("runWithTasks non-TTY silence (silent#*)", () => {
	test("it should write no Listr task output when stdout is not a TTY because pnpm cov must stay free of SimpleRenderer noise", async () => {
		const { out, error } = await withCapturedStdout(false, async () => {
			await runWithTasks("silent-root-sentinel", async () => {});
		});
		expect(error).toBeUndefined();
		expect(out).toBe("");
	});

	test("it should keep nested groups silent when stdout is not a TTY because nested newListr must inherit the parent's silence", async () => {
		const { out, error } = await withCapturedStdout(false, async () => {
			await runWithTasks("silent-parent-sentinel", [
				taskGroup("silent-group-sentinel", [
					task("silent-child-sentinel", async () => {}),
				]),
			]);
		});
		expect(error).toBeUndefined();
		expect(out).toBe("");
	});

	test("it should treat undefined isTTY like non-TTY and stay silent because falsy TTY must not fall back to SimpleRenderer", async () => {
		const { out, error } = await withCapturedStdout(undefined, async () => {
			await runWithTasks("silent-undefined-tty-sentinel", async () => {});
		});
		expect(error).toBeUndefined();
		expect(out).toBe("");
	});

	test("it should still reject on task failure when stdout is not a TTY because silence must not swallow errors", async () => {
		const { out, error } = await withCapturedStdout(false, async () => {
			await runWithTasks("silent-fail-sentinel", async () => {
				throw new Error("sentinel-silent-failure");
			});
		});
		expect(error).toMatchObject({
			message: expect.stringMatching(/sentinel-silent-failure/u),
		});
		expect(out).toBe("");
	});
});

describe("runWithTasks TTY progressive (silent#tty-*)", () => {
	test("it should emit progressive DefaultRenderer output when stdout is a TTY because interactive runs must still show live task progress", async () => {
		const { out, error } = await withCapturedStdout(true, async () => {
			await runWithTasks("tty-progress-sentinel", async () => {}, {
				collapseErrors: false,
			});
		});
		expect(error).toBeUndefined();
		expect(out).toContain("tty-progress-sentinel");
		expect(out.includes("\u001b")).toBe(true);
	});
});
