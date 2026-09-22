import { describe, expect, test, vi } from "vitest";
import { runWithTasks, task, taskGroup } from "./tasks";

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
					task: async () => calls.push("hook"),
					subtasks: [task("a", async () => calls.push("child"))],
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
