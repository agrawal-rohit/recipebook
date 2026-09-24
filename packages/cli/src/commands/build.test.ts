import { resolve } from "node:path";
import type * as core from "@recipebook/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildCommand } from "./build";

const coreMocks = vi.hoisted(() => ({
	buildRegistry: vi.fn(),
}));

vi.mock("@recipebook/core", async (importOriginal) => ({
	...(await importOriginal()),
	...coreMocks,
}));

/** Build overrides as accepted from the CLI, mirroring core's option names. */
type BuildOverrides = Omit<core.BuildRegistryOptions, "sourceDir" | "outDir">;

/** Registry document a successful `buildRegistry` would have written. */
function builtRegistryWithItems(itemIds: string[]): core.Registry {
	return {
		types: { component: { label: "Components" } },
		items: Object.fromEntries(
			itemIds.map((id) => [
				id,
				{
					title: id,
					description: `The ${id} component`,
					type: "component",
					source: `r/${id}.json`,
				},
			]),
		),
	};
}

let logOutput: string[];

describe("buildCommand orchestration", () => {
	beforeEach(() => {
		coreMocks.buildRegistry.mockReset();
		coreMocks.buildRegistry.mockResolvedValue(
			builtRegistryWithItems(["button", "input"]),
		);

		logOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map((arg) => String(arg)).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("it should call buildRegistry with the default sourceDir and outDir and leave every unset override undefined because core owns the build defaults", async () => {
		await buildCommand(".", "dist", {});

		expect(coreMocks.buildRegistry).toHaveBeenCalledTimes(1);
		expect(coreMocks.buildRegistry).toHaveBeenCalledWith({
			sourceDir: ".",
			outDir: "dist",
			registryFileName: undefined,
			itemManifestFileName: undefined,
			typesFileName: undefined,
			conditionsFileName: undefined,
			compiledDirName: undefined,
			bundleExternalPackages: undefined,
		});
	});

	test("it should map every override to its BuildRegistryOptions field because the CLI flags mirror core's options one-to-one", async () => {
		const overrides: BuildOverrides = {
			registryFileName: "index.json",
			itemManifestFileName: "manifest.json",
			typesFileName: "custom/types.json",
			conditionsFileName: "shared/conditions.json",
			compiledDirName: "compiled",
			bundleExternalPackages: ["lodash", "chalk"],
		};

		await buildCommand("registry-src", "registry-dist", overrides);

		expect(coreMocks.buildRegistry).toHaveBeenCalledTimes(1);
		expect(coreMocks.buildRegistry).toHaveBeenCalledWith({
			sourceDir: "registry-src",
			outDir: "registry-dist",
			...overrides,
		});
	});

	test("it should surface core build errors unchanged because the CLI must not pre-validate or wrap core's validation messages", async () => {
		coreMocks.buildRegistry.mockRejectedValue(
			new Error('registryFileName must end with ".json".'),
		);

		await expect(buildCommand(".", "dist", {})).rejects.toThrow(
			'registryFileName must end with ".json".',
		);
	});

	test("it should print the resolved written index path and the item count on success because the author needs to know exactly which file the compiled registry landed in and how big it is", async () => {
		await buildCommand(".", "dist", {});

		const output = logOutput.join("\n");
		expect(output).toContain(resolve("dist", "registry.json"));
		expect(output).toContain("2");
	});

	test("it should print the overridden index file name in the resolved output path because the printed location must reflect --registry-file-name, not just outDir", async () => {
		await buildCommand(".", "dist", { registryFileName: "index.json" });

		expect(logOutput.join("\n")).toContain(resolve("dist", "index.json"));
	});
});
