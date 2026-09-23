import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createRejectedScriptExecutor,
	getScriptExecutor,
	type IndexItem,
	type Registry,
	RegistryConditionKind,
	setScriptExecutor,
} from "@yoinker/core";
import { afterEach, describe, expect, test } from "vitest";
import { prepareScriptExecution, projectScriptHelpers } from "./scripts";

const buttonItem: IndexItem = {
	title: "Button",
	description: "A button component",
	type: "component",
	source: "r/compiled/button.json",
};

function registryWithItems(items: Record<string, IndexItem>): Registry {
	return { types: { component: { label: "Components" } }, items };
}

describe("prepareScriptExecution", () => {
	afterEach(() => {
		// Reset the process-wide executor so classification tests cannot leak into each other.
		setScriptExecutor(createRejectedScriptExecutor());
	});

	test("it should classify a remote HTTPS index as remote with scripts closed and install a rejecting executor because remote registries must never load catalog scripts", async () => {
		const result = await prepareScriptExecution({
			indexLocation: "https://example.com/registry.json",
			registry: registryWithItems({ button: buttonItem }),
			itemIds: ["button"],
			projectDir: "/proj",
		});

		expect(result).toEqual({
			trust: "remote",
			allowInfer: false,
			allowMutation: false,
		});
		await expect(
			getScriptExecutor()?.loadModule(
				"https://example.com/registry.json",
				"r/_handlers/framework.handler.js",
				(value): value is unknown => true,
				"invalid",
			),
		).rejects.toThrow(/scripts are not allowed/);
	});

	test("it should refuse mutation hooks on a remote index because remote HTTPS registries cannot execute custom scripts", async () => {
		const hookItem: IndexItem = {
			...buttonItem,
			packs: [
				{
					id: "standard",
					title: "Standard button",
					beforeWrite: ["r/_scripts/hook.js"],
					source: "r/compiled/button.json",
				},
			],
		};

		await expect(
			prepareScriptExecution({
				indexLocation: "https://example.com/registry.json",
				registry: registryWithItems({ button: hookItem }),
				itemIds: ["button"],
				projectDir: "/proj",
			}),
		).rejects.toThrow(/Remote HTTPS registries cannot execute custom scripts/);
	});

	test("it should classify a local index without declared scripts as local with scripts closed because a later load must not fall back to in-process require", async () => {
		const result = await prepareScriptExecution({
			indexLocation: "/registry/registry.json",
			registry: registryWithItems({ button: buttonItem }),
			itemIds: ["button"],
			projectDir: "/proj",
		});

		expect(result).toEqual({
			trust: "local",
			allowInfer: false,
			allowMutation: false,
		});
		await expect(
			getScriptExecutor()?.loadModule(
				"/registry/registry.json",
				"r/_handlers/framework.handler.js",
				(value): value is unknown => true,
				"invalid",
			),
		).rejects.toThrow(/scripts are not allowed/);
	});

	test("it should install a sandbox executor for a local index with an infer handler because declared handlers must load through the sandbox, never in-process", async () => {
		const probeRoot = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "yoinker-prepare-scripts-")),
		);
		fs.writeFileSync(
			path.join(probeRoot, "registry.json"),
			JSON.stringify(registryWithItems({ button: buttonItem })),
		);
		fs.mkdirSync(path.join(probeRoot, "r", "_handlers"), { recursive: true });
		fs.writeFileSync(
			path.join(probeRoot, "r", "_handlers", "framework.handler.js"),
			"module.exports = { infer: () => undefined };",
		);
		const registry = registryWithItems({
			button: { ...buttonItem, requires: ["framework"] },
		});
		registry.conditions = {
			framework: {
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				required: true,
				handler: "r/_handlers/framework.handler.js",
				values: [{ value: "react", label: "React" }],
			},
		};

		try {
			const result = await prepareScriptExecution({
				indexLocation: path.join(probeRoot, "registry.json"),
				registry,
				itemIds: ["button"],
				projectDir: probeRoot,
			});

			expect(result.allowInfer).toBe(true);
			// The sandbox executor verifies integrity before spawning the runner,
			// so a load attempt fails closed on the missing digest instead of the
			// rejecting executor's "scripts are not allowed" message.
			await expect(
				getScriptExecutor()?.loadModule(
					path.join(probeRoot, "registry.json"),
					"r/_handlers/framework.handler.js",
					(value): value is unknown => true,
					"invalid",
				),
			).rejects.toThrow(/Missing integrity digest/);
		} finally {
			fs.rmSync(probeRoot, { recursive: true, force: true });
		}
	});

	test("it should reject a relative index location because trust classification requires an absolute path or HTTPS URL", async () => {
		await expect(
			prepareScriptExecution({
				indexLocation: "relative/registry.json",
				registry: registryWithItems({ button: buttonItem }),
				itemIds: ["button"],
				projectDir: "/proj",
			}),
		).rejects.toThrow(/absolute path or HTTPS URL/);
	});
});

describe("projectScriptHelpers", () => {
	test("it should confine file helpers to the project directory and run commands with the project cwd because catalog scripts must not escape the install root", async () => {
		const projectDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "yoinker-script-helpers-")),
		);
		fs.writeFileSync(path.join(projectDir, "inside.txt"), "yes");

		try {
			const runtime = projectScriptHelpers(projectDir);

			expect(runtime.projectDir).toBe(projectDir);
			await expect(runtime.isFile("inside.txt")).resolves.toBe(true);
			await expect(runtime.isFile("missing.txt")).resolves.toBe(false);
			await expect(runtime.isFile("../outside.txt")).rejects.toThrow(
				/must be a relative path under the project directory/,
			);
			await expect(runtime.run("pwd")).resolves.toBe(projectDir);
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});
});
