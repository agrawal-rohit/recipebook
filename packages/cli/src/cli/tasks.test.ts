import { describe, expect, test } from "vitest";
import { runWithTasks, task, taskGroup } from "./tasks";

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
