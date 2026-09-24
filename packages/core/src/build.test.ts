import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Registry } from "./index";
import { buildRegistry } from "./index";

let sourceDir: string;
let outDir: string;

beforeEach(() => {
	sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipebook-build-src-"));
	outDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipebook-build-out-"));
});

afterEach(() => {
	fs.rmSync(sourceDir, { recursive: true, force: true });
	fs.rmSync(outDir, { recursive: true, force: true });
});

/** Minimal source tree: one item folder with a file and a beforeWrite script. */
function writeHappySourceTree(): void {
	fs.writeFileSync(
		path.join(sourceDir, "types.json"),
		JSON.stringify({ component: { label: "Components" } }),
	);
	fs.mkdirSync(path.join(sourceDir, "button", "src"), { recursive: true });
	fs.writeFileSync(
		path.join(sourceDir, "button", "registry-item.json"),
		JSON.stringify({
			id: "button",
			title: "Button",
			description: "A button component",
			type: "component",
			files: [{ source: "src/main.txt", target: "src/main.txt" }],
			beforeWrite: ["hook.ts"],
		}),
	);
	fs.writeFileSync(path.join(sourceDir, "button", "src", "main.txt"), "Hello");
	fs.writeFileSync(
		path.join(sourceDir, "button", "hook.ts"),
		"export default async () => undefined;",
	);
}

describe("buildRegistry happy path", () => {
	test("it should write registry.json with the compiled item source, inlined payload, and valid integrity digests because consumers install from the index alone", async () => {
		writeHappySourceTree();
		const registry: Registry = await buildRegistry({ sourceDir, outDir });

		expect(Object.keys(registry.items)).toEqual(["button"]);
		expect(registry.items.button.source).toBe("r/button.json");
		expect(registry.items.button.beforeWrite).toEqual([
			"r/button.beforeWrite.0.js",
		]);

		const payload = JSON.parse(
			fs.readFileSync(path.join(outDir, "r/button.json"), "utf8"),
		) as CompiledPayload;
		expect(payload.files).toEqual([
			{ target: "src/main.txt", content: "Hello" },
		]);

		expect(registry.itemIntegrity?.["r/button.json"]).toMatch(/^sha256-/);
		expect(registry.scriptIntegrity?.["r/button.beforeWrite.0.js"]).toMatch(
			/^sha256-[A-Za-z0-9+/]+={0,2}$/,
		);
		expect(fs.existsSync(path.join(outDir, "r/button.beforeWrite.0.js"))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(outDir, "registry.json"))).toBe(true);
	});
});

type CompiledPayload = {
	files: Array<{ target: string; content: string }>;
};

describe("buildRegistry rejections", () => {
	test("it should reject a file target that escapes the project root because installs must stay confined", async () => {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "button", "src"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				files: [{ source: "src/main.txt", target: "../escape.txt" }],
			}),
		);
		fs.writeFileSync(path.join(sourceDir, "button", "src", "main.txt"), "x");

		await expect(buildRegistry({ sourceDir, outDir })).rejects.toThrowError(
			/must be a relative path/,
		);
	});

	test("it should reject a missing types document because the index needs display metadata", async () => {
		await expect(buildRegistry({ sourceDir, outDir })).rejects.toThrowError(
			"Registry types not found at types.json.",
		);
	});

	test("it should reject invalid output file names because compiled artifacts must be single JSON path segments", async () => {
		writeHappySourceTree();
		await expect(
			buildRegistry({
				sourceDir,
				outDir,
				registryFileName: "nested/registry.json",
			}),
		).rejects.toThrowError(/must be a single path segment/);
		await expect(
			buildRegistry({ sourceDir, outDir, registryFileName: "index" }),
		).rejects.toThrowError('registryFileName must end with ".json".');
	});
});

describe("buildRegistry directory file sources", () => {
	/** Item whose single `files` entry points at the `src` directory. */
	function writeDirSourceTree(target: string): void {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "button", "src", "sub"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				files: [{ source: "src", target }],
			}),
		);
		fs.writeFileSync(path.join(sourceDir, "button", "src", "a.txt"), "A");
		fs.writeFileSync(
			path.join(sourceDir, "button", "src", "sub", "b.txt"),
			"B",
		);
	}

	test("it should inline every leaf file of a directory source with the inner path appended to the target because directory payloads are tree copies", async () => {
		writeDirSourceTree("out");
		const registry = await buildRegistry({ sourceDir, outDir });

		const payload = JSON.parse(
			fs.readFileSync(path.join(outDir, "r/button.json"), "utf8"),
		) as { files: Array<{ target: string; content: string }> };
		expect(payload.files).toEqual([
			{ target: "out/a.txt", content: "A" },
			{ target: "out/sub/b.txt", content: "B" },
		]);
		expect(registry.items.button.source).toBe("r/button.json");
	});

	test("it should trim trailing slashes from the target root because joined targets must not double-separate", async () => {
		writeDirSourceTree("out/");
		await buildRegistry({ sourceDir, outDir });

		const payload = JSON.parse(
			fs.readFileSync(path.join(outDir, "r/button.json"), "utf8"),
		) as { files: Array<{ target: string }> };
		expect(payload.files[0].target).toBe("out/a.txt");
	});

	test("it should reject a file source that is neither a file nor a directory because missing payloads must fail the build", async () => {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "button"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				files: [{ source: "nope.txt", target: "x.txt" }],
			}),
		);

		await expect(buildRegistry({ sourceDir, outDir })).rejects.toThrowError(
			/Registry item "button" references missing file: .*/,
		);
	});

	test("it should reject a base file and pack file that share a target with different content because the payload namespace is one", async () => {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "button"), { recursive: true });
		fs.writeFileSync(path.join(sourceDir, "button", "a.txt"), "base");
		fs.writeFileSync(path.join(sourceDir, "button", "b.txt"), "pack");
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				files: [{ source: "a.txt", target: "x.txt" }],
				packs: [
					{
						id: "ts",
						title: "TypeScript",
						files: [{ source: "b.txt", target: "x.txt" }],
					},
				],
			}),
		);

		await expect(buildRegistry({ sourceDir, outDir })).rejects.toThrowError(
			/declares duplicate file target "x.txt"/,
		);
	});
});

describe("buildRegistry pack index building", () => {
	function writePackSourceTree(): void {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "conditions"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "conditions", "conditions.json"),
			JSON.stringify({
				framework: {
					label: "Framework",
					kind: "select",
					values: [{ value: "react", label: "React" }],
				},
			}),
		);
		fs.mkdirSync(path.join(sourceDir, "button"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "button", "hook.ts"),
			"export default async () => undefined;",
		);
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				packs: [
					{
						id: "ts",
						title: "TypeScript",
						when: { framework: "react" },
						dependsOn: ["other"],
						beforeWrite: ["hook.ts"],
						afterInstall: ["hook.ts"],
					},
				],
			}),
		);
	}

	test("it should compile a pack index entry with source, when, dependsOn, and per-pack script URIs because the index must be installable alone", async () => {
		writePackSourceTree();
		const registry = await buildRegistry({ sourceDir, outDir });
		const pack = registry.items.button.packs?.[0];
		expect(pack).toEqual({
			id: "ts",
			title: "TypeScript",
			source: "r/button/ts.json",
			when: { framework: "react" },
			dependsOn: ["other"],
			beforeWrite: ["r/button/ts.beforeWrite.0.js"],
			afterInstall: ["r/button/ts.afterInstall.0.js"],
		});
	});

	test("it should omit the index source when the base layer has no compiled payload because script-only items carry no files", async () => {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "button"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "button", "hook.ts"),
			"export default async () => undefined;",
		);
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				beforeWrite: ["hook.ts"],
			}),
		);
		const registry = await buildRegistry({ sourceDir, outDir });

		expect(registry.items.button).not.toHaveProperty("source");
		expect(registry.items.button.beforeWrite).toEqual([
			"r/button.beforeWrite.0.js",
		]);
	});

	test("it should sort index items by id regardless of source-tree order because the index must be deterministic", async () => {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		for (const id of ["zebra", "alpha"]) {
			fs.mkdirSync(path.join(sourceDir, id), { recursive: true });
			fs.writeFileSync(path.join(sourceDir, id, "f.txt"), id);
			fs.writeFileSync(
				path.join(sourceDir, id, "registry-item.json"),
				JSON.stringify({
					id,
					title: id,
					description: id,
					type: "component",
					files: [{ source: "f.txt", target: "f.txt" }],
				}),
			);
		}
		const registry = await buildRegistry({ sourceDir, outDir });
		expect(Object.keys(registry.items)).toEqual(["alpha", "zebra"]);
	});

	test("it should keep per-pack bundles distinct from item-level bundles because pack hooks are selected independently", async () => {
		writePackSourceTree();
		const registry = await buildRegistry({ sourceDir, outDir });

		expect(fs.existsSync(path.join(outDir, "r/button.beforeWrite.0.js"))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(outDir, "r/button/ts.beforeWrite.0.js")),
		).toBe(true);
		expect(registry.items.button.beforeWrite).toBeUndefined();
		expect(registry.scriptIntegrity?.["r/button/ts.beforeWrite.0.js"]).toMatch(
			/^sha256-[A-Za-z0-9+/]+={0,2}$/,
		);
	});
});

describe("buildRegistry bundle require-scan", () => {
	function writeScriptSourceTree(scriptBody: string): void {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "button"), { recursive: true });
		fs.writeFileSync(path.join(sourceDir, "button", "hook.ts"), scriptBody);
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				beforeWrite: ["hook.ts"],
			}),
		);
	}

	test("it should reject a script that runtime-requires an external package because bundles must stay self-contained", async () => {
		writeScriptSourceTree(
			'module.exports = async () => require("@recipebook/core");',
		);
		await expect(buildRegistry({ sourceDir, outDir })).rejects.toThrowError(
			/Registry item "button" beforeWrite must not runtime-import @recipebook\/core\./,
		);
	});

	test("it should allow a type-only import because esbuild erases types before the require scan", async () => {
		writeScriptSourceTree(
			'import type { X } from "@recipebook/core";\nexport default async () => 1;',
		);
		const registry = await buildRegistry({ sourceDir, outDir });
		expect(registry.items.button.beforeWrite).toEqual([
			"r/button.beforeWrite.0.js",
		]);
	});

	test("it should reject runtime imports of caller-declared external packages because the ban list is caller-owned", async () => {
		writeScriptSourceTree('module.exports = async () => require("left-pad");');
		await expect(
			buildRegistry({
				sourceDir,
				outDir,
				bundleExternalPackages: ["left-pad"],
			}),
		).rejects.toThrowError(/must not runtime-import left-pad\./);
	});
});

describe("buildRegistry condition handler compilation", () => {
	function writeSharedHandlerSourceTree(): void {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "conditions"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "conditions", "conditions.json"),
			JSON.stringify({
				framework: {
					label: "Framework",
					kind: "select",
					values: [{ value: "react", label: "React" }],
					handler: "conditions/framework.handler.ts",
				},
			}),
		);
		fs.writeFileSync(
			path.join(sourceDir, "conditions", "framework.handler.ts"),
			"export default { infer: async () => undefined };",
		);
	}

	test("it should bundle a shared condition handler to r/_handlers and rewrite the index handler URI because installs execute handlers from the compiled catalog", async () => {
		writeSharedHandlerSourceTree();
		const registry = await buildRegistry({ sourceDir, outDir });

		expect(registry.conditions?.framework).toEqual({
			label: "Framework",
			kind: "select",
			values: [{ value: "react", label: "React" }],
			handler: "r/_handlers/framework.handler.js",
		});
		expect(
			fs.existsSync(path.join(outDir, "r/_handlers/framework.handler.js")),
		).toBe(true);
	});

	test("it should bundle an item-local condition handler under the item's handler directory because per-item handlers are namespaced by item id", async () => {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "button"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "button", "size.handler.ts"),
			"export default { infer: async () => undefined };",
		);
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				conditions: {
					size: {
						label: "Size",
						kind: "select",
						values: [{ value: "sm", label: "Small" }],
						handler: "size.handler.ts",
					},
				},
				beforeWrite: ["hook.ts"],
			}),
		);
		fs.writeFileSync(
			path.join(sourceDir, "button", "hook.ts"),
			"export default async () => undefined;",
		);

		const registry = await buildRegistry({ sourceDir, outDir });

		expect(registry.items.button.conditions?.size).toEqual({
			label: "Size",
			kind: "select",
			values: [{ value: "sm", label: "Small" }],
			handler: "r/_handlers/items/button/size.handler.js",
		});
		expect(
			fs.existsSync(
				path.join(outDir, "r/_handlers/items/button/size.handler.js"),
			),
		).toBe(true);
	});

	test("it should reject an unloadable script with the bundling label because a syntax error in a registry script must name the failing script", async () => {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "button"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				beforeWrite: ["broken.ts"],
			}),
		);
		fs.writeFileSync(
			path.join(sourceDir, "button", "broken.ts"),
			"export default async () => {",
		);

		await expect(buildRegistry({ sourceDir, outDir })).rejects.toThrowError(
			/Failed to bundle Registry item "button" beforeWrite/u,
		);
	});
});

describe("buildRegistry config validation", () => {
	test("it should reject empty bundleExternalPackages entries because a blank ban-list entry would silently unban nothing", async () => {
		await expect(
			buildRegistry({ sourceDir, outDir, bundleExternalPackages: ["  "] }),
		).rejects.toThrowError("bundleExternalPackages entries must be non-empty.");
	});
});

describe("buildRegistry source directory walking", () => {
	test("it should treat a missing source directory as an empty item tree because the types check reports the real problem", async () => {
		await expect(
			buildRegistry({ sourceDir: path.join(sourceDir, "missing"), outDir }),
		).rejects.toThrowError("Registry types not found at types.json.");
	});

	test("it should fail fast when the source path is a file because ENOTDIR is not a missing path", async () => {
		const filePath = path.join(sourceDir, "not-a-dir");
		fs.writeFileSync(filePath, "x");
		await expect(
			buildRegistry({ sourceDir: filePath, outDir }),
		).rejects.toThrowError(/ENOTDIR/u);
	});
});

describe("buildRegistry item identity", () => {
	/** Types file shared by single-item fixtures. */
	function writeTypesFile(): void {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
	}

	test("it should reject two item folders declaring the same id because the index must key items uniquely", async () => {
		writeTypesFile();
		for (const dir of ["alpha", "beta"]) {
			fs.mkdirSync(path.join(sourceDir, dir), { recursive: true });
			fs.writeFileSync(
				path.join(sourceDir, dir, "registry-item.json"),
				JSON.stringify({
					id: "button",
					title: "Button",
					description: "A button component",
					type: "component",
					files: [{ source: "f.txt", target: "f.txt" }],
				}),
			);
			fs.writeFileSync(path.join(sourceDir, dir, "f.txt"), "x");
		}
		await expect(buildRegistry({ sourceDir, outDir })).rejects.toThrowError(
			'Duplicate registry item id: "button".',
		);
	});

	test("it should compile a base payload for a script-only item that also declares secrets because secret env vars ride the payload", async () => {
		writeTypesFile();
		fs.mkdirSync(path.join(sourceDir, "button"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "button", "hook.ts"),
			"export default async () => undefined;",
		);
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				beforeWrite: ["hook.ts"],
				secrets: ["API_KEY"],
			}),
		);
		const registry = await buildRegistry({ sourceDir, outDir });
		expect(registry.items.button.source).toBe("r/button.json");
	});

	test("it should reject a beforeWrite entry that is not a file because builds must not ship dangling hooks", async () => {
		writeTypesFile();
		fs.mkdirSync(path.join(sourceDir, "button"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				beforeWrite: ["missing.ts"],
			}),
		);
		await expect(buildRegistry({ sourceDir, outDir })).rejects.toThrowError(
			/references missing script:/u,
		);
	});
});

describe("buildRegistry optional index fields", () => {
	test('it should join directory file targets without a root prefix when the target is the project root because "." means install root', async () => {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "button", "src", "sub"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				files: [{ source: "src", target: "." }],
			}),
		);
		fs.writeFileSync(path.join(sourceDir, "button", "src", "a.txt"), "A");
		fs.writeFileSync(
			path.join(sourceDir, "button", "src", "sub", "b.txt"),
			"B",
		);
		await buildRegistry({ sourceDir, outDir });

		const payload = JSON.parse(
			fs.readFileSync(path.join(outDir, "r/button.json"), "utf8"),
		) as { files: Array<{ target: string; content: string }> };
		expect(payload.files).toEqual([
			{ target: "a.txt", content: "A" },
			{ target: "sub/b.txt", content: "B" },
		]);
	});

	test("it should omit when, dependsOn, and script lists from a bare pack index entry because absent declarations must stay absent", async () => {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "button"), { recursive: true });
		fs.writeFileSync(path.join(sourceDir, "button", "f.txt"), "x");
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				packs: [{ id: "ts", title: "TypeScript" }],
			}),
		);
		const registry = await buildRegistry({ sourceDir, outDir });
		expect(registry.items.button.packs).toEqual([
			{ id: "ts", title: "TypeScript", source: "r/button/ts.json" },
		]);
	});

	test("it should copy requires, dependsOn, and afterInstall onto the index because the install planner needs them", async () => {
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			JSON.stringify({ component: { label: "Components" } }),
		);
		fs.mkdirSync(path.join(sourceDir, "conditions"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "conditions", "conditions.json"),
			JSON.stringify({
				framework: {
					label: "Framework",
					kind: "select",
					values: [{ value: "react", label: "React" }],
				},
			}),
		);
		fs.mkdirSync(path.join(sourceDir, "button"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "button", "hook.ts"),
			"export default async () => undefined;",
		);
		fs.writeFileSync(
			path.join(sourceDir, "button", "registry-item.json"),
			JSON.stringify({
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				requires: ["framework"],
				dependsOn: ["other"],
				beforeWrite: ["hook.ts"],
				afterInstall: ["hook.ts"],
			}),
		);
		const registry = await buildRegistry({ sourceDir, outDir });

		expect(registry.items.button.requires).toEqual(["framework"]);
		expect(registry.items.button.dependsOn).toEqual(["other"]);
		expect(registry.items.button.afterInstall).toEqual([
			"r/button.afterInstall.0.js",
		]);
	});
});
