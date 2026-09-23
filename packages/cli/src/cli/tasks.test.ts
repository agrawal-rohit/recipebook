import { describe, expect, test } from "vitest";
import { runWithTasks, task, taskGroup } from "./tasks";

describe("taskGroup", () => {
	test("it should reject an empty subtask list because a group with no work would render a dead progress node", () => {
		expect(() => taskGroup("empty group", [])).toThrowError(
			'Task group "empty group" has no work.',
		);
	});
});

describe("runWithTasks edge cases", () => {
	test("it should run a group node's own task function before its nested subtasks because a node can carry both", async () => {
		const order: string[] = [];
		await runWithTasks("goal", [
			{
				title: "group",
				task: async () => {
					order.push("own");
				},
				subtasks: [
					task("nested", async () => {
						order.push("nested");
					}),
				],
			},
		]);
		expect(order).toEqual(["own", "nested"]);
	});

	test("it should reject a leaf subtask without a task function because a childless node with no work cannot execute", async () => {
		await expect(
			runWithTasks("goal", [{ title: "idle" }]),
		).rejects.toThrowError('Subtask "idle" has no work.');
	});

	test("it should reject an empty subtask list because runWithTasks requires work", async () => {
		await expect(runWithTasks("idle goal", [])).rejects.toThrowError(
			'Task "idle goal" has no work.',
		);
	});
});

describe("runWithTasks execution contract", () => {
	test("it should run a function-form task to completion", async () => {
		let ran = false;
		await runWithTasks("goal", async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});

	test("it should run subtasks in order, including nested groups", async () => {
		const order: string[] = [];
		await runWithTasks("goal", [
			task("first", async () => {
				order.push("first");
			}),
			taskGroup("group", [
				task("nested", async () => {
					order.push("nested");
				}),
			]),
			task("last", async () => {
				order.push("last");
			}),
		]);
		expect(order).toEqual(["first", "nested", "last"]);
	});

	test("it should propagate a rejection from a subtask", async () => {
		await expect(
			runWithTasks("goal", [
				task("boom", async () => {
					throw new Error("kaboom");
				}),
			]),
		).rejects.toThrow(/kaboom/);
	});

	test("it should propagate a rejection from a function-form task", async () => {
		await expect(
			runWithTasks("goal", async () => {
				throw new Error("stop");
			}),
		).rejects.toThrow(/stop/);
	});
});
