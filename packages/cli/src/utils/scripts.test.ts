import {
	getScriptExecutor,
	RegistryConditionKind,
	RegistryTrust,
	setScriptExecutor,
} from "@cheetos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConfirmInput = vi.fn();
const mockBundledRegistryPath = vi.fn(() => "/bundled/registry.json");

vi.mock("../cli/prompts", () => ({
	confirmInput: (...args: unknown[]) => mockConfirmInput(...args),
}));

vi.mock("./registry", () => ({
	bundledRegistryPath: () => mockBundledRegistryPath(),
}));

import { prepareScriptExecution } from "./scripts";

afterEach(() => {
	setScriptExecutor(undefined);
	vi.clearAllMocks();
});

beforeEach(() => {
	mockBundledRegistryPath.mockReturnValue("/bundled/registry.json");
	mockConfirmInput.mockResolvedValue(true);
});

describe("prepareScriptExecution", () => {
	const registry = {
		types: { configuration: { label: "Configurations" } },
		items: {
			license: {
				title: "License",
				description: "SPDX",
				type: "configuration",
				beforeWrite: ["r/license.beforeWrite.0.js"],
			},
		},
	};

	it("allows bundled registry scripts without prompting", async () => {
		const result = await prepareScriptExecution({
			indexLocation: "/bundled/registry.json",
			registry,
			itemIds: ["license"],
			projectDir: "/project",
		});

		expect(result).toEqual({
			trust: RegistryTrust.BUNDLED,
			allowInfer: false,
			allowMutation: true,
		});
		expect(mockConfirmInput).not.toHaveBeenCalled();
	});

	it("allows non-bundled local registry scripts without prompting", async () => {
		const result = await prepareScriptExecution({
			indexLocation: "/other/registry.json",
			registry,
			itemIds: ["license"],
			projectDir: "/project",
		});

		expect(result.trust).toBe(RegistryTrust.LOCAL);
		expect(result.allowMutation).toBe(true);
		expect(mockConfirmInput).not.toHaveBeenCalled();
	});

	it("refuses remote HTTPS mutation hooks", async () => {
		await expect(
			prepareScriptExecution({
				indexLocation: "https://example.com/registry.json",
				registry,
				itemIds: ["license"],
				projectDir: "/project",
			}),
		).rejects.toThrow("Remote HTTPS registries cannot execute custom scripts");
	});

	it("skips infer handlers on a remote registry and installs a rejecting executor", async () => {
		const result = await prepareScriptExecution({
			indexLocation: "https://example.com/registry.json",
			registry: {
				types: { configuration: { label: "Configurations" } },
				conditions: {
					language: {
						kind: RegistryConditionKind.SELECT,
						label: "Language",
						handler: "conditions/language.ts",
						values: [{ value: "typescript", label: "TypeScript" }],
					},
				},
				items: {
					testing: {
						title: "Testing",
						description: "Testing",
						type: "configuration",
						requires: ["language"],
					},
				},
			},
			itemIds: ["testing"],
			projectDir: "/project",
		});

		expect(result).toEqual({
			trust: RegistryTrust.REMOTE,
			allowInfer: false,
			allowMutation: false,
		});
		await expect(
			getScriptExecutor()?.loadModule(
				"/registry.json",
				"conditions/language.ts",
				(value: unknown): value is unknown => true,
				"unused",
			),
		).rejects.toThrow("cannot run");
	});
});
