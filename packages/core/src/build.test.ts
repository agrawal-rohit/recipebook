import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRegistry } from "./build";
import type { CompiledItem, Registry } from "./schema";

/**
 * Write a registry item fixture under a temp package root.
 * @param packageRoot - Absolute temp package root.
 * @param relativeDir - Item folder relative to registry/.
 * @param manifest - Manifest object written as registry-item.json.
 * @param files - Source files to create relative to the item folder.
 */
function writeItem(
	packageRoot: string,
	relativeDir: string,
	manifest: Record<string, unknown>,
	files: Record<string, string> = {},
): void {
	const itemDir = path.join(packageRoot, "registry", relativeDir);
	fs.mkdirSync(itemDir, { recursive: true });
	fs.writeFileSync(
		path.join(itemDir, "registry-item.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);
	for (const [relativePath, content] of Object.entries(files)) {
		const absolutePath = path.join(itemDir, relativePath);
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, content, "utf8");
	}
}

/**
 * Write a JSON file under registry/ (conditions/conditions.json, types.json, etc.).
 * @param packageRoot - Absolute temp package root.
 * @param fileName - File name under registry/ (may include subdirectories).
 * @param data - Object written as JSON.
 */
function writeRegistryJson(
	packageRoot: string,
	fileName: string,
	data: Record<string, unknown>,
): void {
	const absolutePath = path.join(packageRoot, "registry", fileName);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(absolutePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

describe("buildRegistry", () => {
	let tempDir: string;

	/**
	 * Run buildRegistry against the current temp fixture root.
	 * @returns The built registry document.
	 */
	function runBuild() {
		return buildRegistry({
			sourceDir: path.join(tempDir, "registry"),
			outDir: tempDir,
		});
	}

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-build-"));
		writeRegistryJson(tempDir, "types.json", {
			component: { label: "Components" },
			configuration: { label: "Configurations" },
		});
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 });
	});

	it("builds registry.json with install targets and per-pack compiled items", async () => {
		writeItem(
			tempDir,
			"component/button",
			{
				id: "button",
				title: "Button",
				description: "A button",
				type: "component",
				packs: [
					{
						id: "react",
						title: "React",
						dependencies: {
							npm: {
								runtime: ["react"],
							},
						},
						files: [
							{
								source: "react/button.tsx",
								target: "src/components/ui/button.tsx",
							},
						],
					},
				],
			},
			{ "react/button.tsx": "export const Button = () => null;\n" },
		);
		writeItem(
			tempDir,
			"configuration/build",
			{
				id: "build",
				title: "Build",
				description: "Build workflow",
				type: "configuration",
				packs: [
					{
						id: "github-actions",
						title: "GitHub Actions",
						files: [
							{
								source: "github-actions/.github/workflows/build.yml",
								target: ".github/workflows/build.yml",
							},
						],
					},
				],
			},
			{
				"github-actions/.github/workflows/build.yml": "name: build\n",
			},
		);

		const document = await runBuild();
		const written = JSON.parse(
			fs.readFileSync(path.join(tempDir, "registry.json"), "utf8"),
		) as Registry;

		expect(document).toEqual(written);
		expect(Object.keys(written.items)).toEqual(["build", "button"]);
		expect(fs.readFileSync(path.join(tempDir, "registry.json"), "utf8")).toBe(
			`${JSON.stringify(document)}\n`,
		);
		expect(written.items.button).toEqual({
			title: "Button",
			description: "A button",
			type: "component",
			packs: [
				{
					id: "react",
					title: "React",
					source: "r/button/react.json",
				},
			],
		});
		expect(written.items.button).not.toHaveProperty("id");
		expect(written.items.button.packs?.[0]).not.toHaveProperty("files");
		expect(written.items.button.packs?.[0]).not.toHaveProperty("description");
		expect(written.items.button.packs?.[0]).not.toHaveProperty("dependencies");

		const payloadPath = path.join(tempDir, "r/button/react.json");
		const payloadRaw = fs.readFileSync(payloadPath, "utf8");
		const payload = JSON.parse(payloadRaw) as CompiledItem;
		expect(payload).toEqual({
			files: [
				{
					target: "src/components/ui/button.tsx",
					content: "export const Button = () => null;\n",
				},
			],
			dependencies: {
				npm: {
					runtime: ["react"],
				},
			},
		});
		expect(payload).not.toHaveProperty("id");
		expect(payload).not.toHaveProperty("packId");
		expect(payloadRaw).toBe(`${JSON.stringify(payload)}\n`);
	});

	it("inlines item-level shared files into every pack compiled item", async () => {
		writeItem(
			tempDir,
			"configuration/git-hooks",
			{
				id: "git-hooks",
				title: "Git Hooks",
				description: "Hooks",
				type: "configuration",
				files: [
					{ source: "commitlint.config.js", target: "commitlint.config.js" },
				],
				packs: [
					{
						id: "typescript",
						title: "TypeScript",
						when: { language: "typescript" },
						files: [
							{
								source: "typescript/lint-staged.config.js",
								target: "lint-staged.config.js",
							},
						],
					},
				],
			},
			{
				"commitlint.config.js": "module.exports = {};\n",
				"typescript/lint-staged.config.js": "module.exports = {};\n",
			},
		);
		writeRegistryJson(tempDir, "conditions/conditions.json", {
			language: {
				kind: "select",
				label: "Language",
				values: [{ value: "typescript", label: "TypeScript" }],
			},
		});

		const document = await runBuild();
		expect(document.items["git-hooks"].source).toBe("r/git-hooks.json");
		expect(document.items["git-hooks"]).not.toHaveProperty("id");
		expect(document.items["git-hooks"]).not.toHaveProperty("files");
		expect(document.items["git-hooks"]).not.toHaveProperty("when");
		expect(document.items["git-hooks"].packs?.[0]).toEqual({
			id: "typescript",
			title: "TypeScript",
			source: "r/git-hooks/typescript.json",
			when: { language: "typescript" },
		});

		const payload = JSON.parse(
			fs.readFileSync(
				path.join(tempDir, "r/git-hooks/typescript.json"),
				"utf8",
			),
		) as CompiledItem;
		expect(payload.files.map((file) => file.target)).toEqual([
			"commitlint.config.js",
			"lint-staged.config.js",
		]);
		expect(
			payload.files.every((file) => typeof file.content === "string"),
		).toBe(true);
	});

	it("builds a pack-less item with a top-level payload", async () => {
		writeItem(
			tempDir,
			"workflow/assign-owner",
			{
				id: "assign-owner",
				title: "Assign Owner",
				description: "Assigns the repository owner",
				type: "configuration",
				dependsOn: ["setup-workspace"],
				files: [
					{
						source: ".github/workflows/assign-owner.yml",
						target: ".github/workflows/assign-owner.yml",
					},
				],
			},
			{
				".github/workflows/assign-owner.yml": "name: assign-owner\n",
			},
		);
		writeItem(
			tempDir,
			"configuration/pr-template",
			{
				id: "pr-template",
				title: "PR Template",
				description: "A pull request template",
				type: "configuration",
				files: [
					{
						source: ".github/pull_request_template.md",
						target: ".github/pull_request_template.md",
					},
				],
			},
			{
				".github/pull_request_template.md": "## Summary\n",
			},
		);

		const document = await runBuild();
		expect(document.items["assign-owner"]).toEqual({
			title: "Assign Owner",
			description: "Assigns the repository owner",
			type: "configuration",
			source: "r/assign-owner.json",
			dependsOn: ["setup-workspace"],
		});
		expect(document.items["assign-owner"]).not.toHaveProperty("packs");
		expect(document.items["assign-owner"]).not.toHaveProperty("files");
		expect(document.items["assign-owner"]).not.toHaveProperty("id");
		expect(document.items["pr-template"]).toEqual({
			title: "PR Template",
			description: "A pull request template",
			type: "configuration",
			source: "r/pr-template.json",
		});
		expect(document.items["pr-template"]).not.toHaveProperty("dependsOn");

		const payload = JSON.parse(
			fs.readFileSync(path.join(tempDir, "r/assign-owner.json"), "utf8"),
		) as CompiledItem;
		expect(payload).toEqual({
			files: [
				{
					target: ".github/workflows/assign-owner.yml",
					content: "name: assign-owner\n",
				},
			],
		});
		expect(payload).not.toHaveProperty("id");
		expect(payload).not.toHaveProperty("packId");
	});

	it("builds an empty items map and wipes a stale r/ tree", async () => {
		const stale = path.join(tempDir, "r", "stale", "old.json");
		fs.mkdirSync(path.dirname(stale), { recursive: true });
		fs.writeFileSync(stale, "{}\n", "utf8");
		fs.mkdirSync(path.join(tempDir, "registry"), { recursive: true });

		const document = await runBuild();

		expect(document.items).toEqual({});
		expect(fs.existsSync(path.join(tempDir, "registry.json"))).toBe(true);
		expect(fs.existsSync(path.join(tempDir, "r"))).toBe(false);
	});

	it("treats a missing sourceDir as empty and still requires types.json", async () => {
		await expect(
			buildRegistry({
				sourceDir: path.join(tempDir, "missing-source"),
				outDir: tempDir,
			}),
		).rejects.toThrow("Registry types not found");
	});

	it("throws on duplicate registry item ids", async () => {
		const manifest = {
			id: "button",
			title: "Button",
			description: "A button",
			type: "component",
			packs: [
				{
					id: "default",
					title: "Default",
					files: [{ source: "button.tsx", target: "button.tsx" }],
				},
			],
		};
		writeItem(tempDir, "component/a", manifest, {
			"button.tsx": "export {};\n",
		});
		writeItem(tempDir, "component/b", manifest, {
			"button.tsx": "export {};\n",
		});

		await expect(runBuild()).rejects.toThrow(
			'Duplicate registry item id: "button".',
		);
	});

	it("throws on duplicate pack ids within an item", async () => {
		writeItem(
			tempDir,
			"component/button",
			{
				id: "button",
				title: "Button",
				description: "A button",
				type: "component",
				packs: [
					{
						id: "default",
						title: "Default",
						files: [{ source: "a.txt", target: "a.txt" }],
					},
					{
						id: "default",
						title: "Also default",
						files: [{ source: "b.txt", target: "b.txt" }],
					},
				],
			},
			{ "a.txt": "a\n", "b.txt": "b\n" },
		);

		await expect(runBuild()).rejects.toThrow(
			'Registry item has duplicate pack id "default".',
		);
	});

	it("throws when a declared source file is missing", async () => {
		writeItem(tempDir, "component/button", {
			id: "button",
			title: "Button",
			description: "A button",
			type: "component",
			packs: [
				{
					id: "default",
					title: "Default",
					files: [{ source: "missing.tsx", target: "button.tsx" }],
				},
			],
		});

		await expect(runBuild()).rejects.toThrow(
			'Registry item "button" references missing file:',
		);
	});

	it("expands a directory source into per-file compiled entries", async () => {
		writeItem(
			tempDir,
			"component/widget",
			{
				id: "widget",
				title: "Widget",
				description: "A widget with directory-based sources.",
				type: "component",
				files: [{ source: "react", target: "src/components/widget" }],
			},
			{
				"react/index.tsx": "export const Widget = () => null;\n",
				"react/sub/widget.test.tsx": "test('widget', () => {});\n",
			},
		);

		const document = await runBuild();
		const payload = JSON.parse(
			fs.readFileSync(path.join(tempDir, "r/widget.json"), "utf8"),
		) as CompiledItem;
		expect(payload.files.map((file) => file.target)).toEqual([
			"src/components/widget/index.tsx",
			"src/components/widget/sub/widget.test.tsx",
		]);
		expect(payload.files[0].content).toContain("Widget");
		expect(document.items.widget).toEqual({
			title: "Widget",
			description: "A widget with directory-based sources.",
			type: "component",
			source: "r/widget.json",
		});
	});

	it("anchors a directory source at the project root when target is '.'", async () => {
		writeItem(
			tempDir,
			"component/snippet",
			{
				id: "snippet",
				title: "Snippet",
				description: "Snippets copied to project root.",
				type: "component",
				files: [{ source: "snippets", target: "." }],
			},
			{
				"snippets/hello.md": "# hello\n",
				"snippets/nested/bye.md": "# bye\n",
			},
		);

		await runBuild();
		const payload = JSON.parse(
			fs.readFileSync(path.join(tempDir, "r/snippet.json"), "utf8"),
		) as CompiledItem;
		expect(payload.files.map((file) => file.target)).toEqual([
			"hello.md",
			"nested/bye.md",
		]);
	});

	it("throws when types.json is absent", async () => {
		fs.rmSync(path.join(tempDir, "registry", "types.json"));
		fs.mkdirSync(path.join(tempDir, "registry"), { recursive: true });

		await expect(runBuild()).rejects.toThrow(
			"Registry types not found at types.json.",
		);
	});

	it("does not wipe r/ when types.json is missing", async () => {
		const stale = path.join(tempDir, "r", "stale", "old.json");
		fs.mkdirSync(path.dirname(stale), { recursive: true });
		fs.writeFileSync(stale, "{}\n", "utf8");
		fs.rmSync(path.join(tempDir, "registry", "types.json"));
		fs.mkdirSync(path.join(tempDir, "registry"), { recursive: true });

		await expect(runBuild()).rejects.toThrow(
			"Registry types not found at types.json.",
		);
		expect(fs.existsSync(stale)).toBe(true);
	});

	it("throws when registry-item.json is not valid JSON", async () => {
		const itemDir = path.join(tempDir, "registry", "component", "broken");
		fs.mkdirSync(itemDir, { recursive: true });
		fs.writeFileSync(
			path.join(itemDir, "registry-item.json"),
			"{ not json\n",
			"utf8",
		);

		await expect(runBuild()).rejects.toThrow("is not valid JSON");
	});

	it("throws when a file source escapes the item folder", async () => {
		writeItem(
			tempDir,
			"component/button",
			{
				id: "button",
				title: "Button",
				description: "A button",
				type: "component",
				files: [{ source: "../outside.txt", target: "button.tsx" }],
			},
			{ "button.tsx": "export {};\n" },
		);

		await expect(runBuild()).rejects.toThrow(
			'Registry item.files[0].source must be a relative path (no absolute paths, URLs, or "..").',
		);
	});

	it("throws when an item file and a pack file share a target", async () => {
		writeItem(
			tempDir,
			"configuration/git-hooks",
			{
				id: "git-hooks",
				title: "Git Hooks",
				description: "Hooks",
				type: "configuration",
				files: [{ source: "shared.js", target: "config.js" }],
				packs: [
					{
						id: "typescript",
						title: "TypeScript",
						files: [{ source: "typescript/override.js", target: "config.js" }],
					},
				],
			},
			{
				"shared.js": "module.exports = {};\n",
				"typescript/override.js": "module.exports = { ts: true };\n",
			},
		);

		await expect(runBuild()).rejects.toThrow(
			'Registry item "git-hooks" pack "typescript" declares duplicate file target "config.js".',
		);
	});

	it("throws when an inlined source file is empty", async () => {
		writeItem(
			tempDir,
			"component/button",
			{
				id: "button",
				title: "Button",
				description: "A button",
				type: "component",
				files: [{ source: "empty.txt", target: "empty.txt" }],
			},
			{ "empty.txt": "" },
		);

		await expect(runBuild()).rejects.toThrow('Compiled item for "button"');
	});

	it("throws when a when key is not declared in conditions", async () => {
		writeItem(
			tempDir,
			"configuration/git-hooks",
			{
				id: "git-hooks",
				title: "Git Hooks",
				description: "Hooks",
				type: "configuration",
				packs: [
					{
						id: "typescript",
						title: "TypeScript",
						when: { language: "typescript" },
						files: [{ source: "a.txt", target: "a.txt" }],
					},
				],
			},
			{ "a.txt": "a\n" },
		);

		await expect(runBuild()).rejects.toThrow(
			'Registry item "git-hooks" pack "typescript" references unknown when key "language".',
		);
	});

	it("writes compiled items to outDir independently of sourceDir", async () => {
		const sourceDir = path.join(tempDir, "authoring");
		const outDir = path.join(tempDir, "dist");
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "types.json"),
			`${JSON.stringify({ component: { label: "Components" } }, null, 2)}\n`,
			"utf8",
		);
		const itemDir = path.join(sourceDir, "component/button");
		fs.mkdirSync(itemDir, { recursive: true });
		fs.writeFileSync(
			path.join(itemDir, "registry-item.json"),
			`${JSON.stringify(
				{
					id: "button",
					title: "Button",
					description: "A button",
					type: "component",
					packs: [
						{
							id: "default",
							title: "Default",
							files: [{ source: "a.txt", target: "a.txt" }],
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		fs.writeFileSync(path.join(itemDir, "a.txt"), "a\n", "utf8");

		const document = await buildRegistry({ sourceDir, outDir });

		expect(document.items.button).toBeDefined();
		expect(fs.existsSync(path.join(outDir, "registry.json"))).toBe(true);
		expect(fs.existsSync(path.join(outDir, "r/button/default.json"))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(sourceDir, "registry.json"))).toBe(false);
	});

	it("writes the index under a custom registryFileName", async () => {
		writeItem(
			tempDir,
			"component/button",
			{
				id: "button",
				title: "Button",
				description: "A button",
				type: "component",
				packs: [
					{
						id: "default",
						title: "Default",
						files: [{ source: "a.txt", target: "a.txt" }],
					},
				],
			},
			{ "a.txt": "a\n" },
		);

		const document = await buildRegistry({
			sourceDir: path.join(tempDir, "registry"),
			outDir: tempDir,
			registryFileName: "catalog.json",
		});

		expect(document.items.button).toBeDefined();
		expect(fs.existsSync(path.join(tempDir, "catalog.json"))).toBe(true);
		expect(fs.existsSync(path.join(tempDir, "registry.json"))).toBe(false);
		expect(fs.existsSync(path.join(tempDir, "r/button/default.json"))).toBe(
			true,
		);
	});

	it.each([
		["nested/path.json", "single path segment"],
		["..", "single path segment"],
		[".", "single path segment"],
		["catalog.txt", 'must end with ".json"'],
		["", "single path segment"],
		["   ", "single path segment"],
	])("rejects invalid registryFileName %j", async (registryFileName, message) => {
		await expect(
			buildRegistry({
				sourceDir: path.join(tempDir, "registry"),
				outDir: tempDir,
				registryFileName,
			}),
		).rejects.toThrow(message);
	});

	it("honours custom authoring layout and compiledDirName", async () => {
		const sourceDir = path.join(tempDir, "authoring");
		const itemDir = path.join(sourceDir, "items", "button");
		fs.mkdirSync(itemDir, { recursive: true });
		fs.mkdirSync(path.join(sourceDir, "shared"), { recursive: true });
		fs.writeFileSync(
			path.join(sourceDir, "item-types.json"),
			`${JSON.stringify({ component: { label: "Components" } }, null, 2)}\n`,
			"utf8",
		);
		fs.writeFileSync(
			path.join(sourceDir, "shared", "conditions.json"),
			`${JSON.stringify(
				{
					language: {
						kind: "select",
						label: "Language",
						values: [{ value: "typescript", label: "TypeScript" }],
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		fs.writeFileSync(
			path.join(itemDir, "item.json"),
			`${JSON.stringify(
				{
					id: "button",
					title: "Button",
					description: "A button",
					type: "component",
					requires: ["language"],
					files: [{ source: "a.txt", target: "a.txt" }],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		fs.writeFileSync(path.join(itemDir, "a.txt"), "ok\n", "utf8");

		const document = await buildRegistry({
			sourceDir,
			outDir: tempDir,
			itemManifestFileName: "item.json",
			typesFileName: "item-types.json",
			conditionsFileName: "shared/conditions.json",
			compiledDirName: "payloads",
			registryFileName: "catalog.json",
		});

		expect(document.items.button).toEqual({
			title: "Button",
			description: "A button",
			type: "component",
			requires: ["language"],
			source: "payloads/button.json",
		});
		expect(document.conditions?.language).toBeDefined();
		expect(fs.existsSync(path.join(tempDir, "catalog.json"))).toBe(true);
		expect(fs.existsSync(path.join(tempDir, "payloads/button.json"))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(tempDir, "r"))).toBe(false);
	});

	it.each([
		["nested/path.json", "single path segment"],
		["..", "single path segment"],
		["item.txt", 'must end with ".json"'],
	])("rejects invalid itemManifestFileName %j", async (itemManifestFileName, message) => {
		await expect(
			buildRegistry({
				sourceDir: path.join(tempDir, "registry"),
				outDir: tempDir,
				itemManifestFileName,
			}),
		).rejects.toThrow(message);
	});

	it.each([
		["nested/out", "single path segment"],
		["..", "single path segment"],
		["", "single path segment"],
	])("rejects invalid compiledDirName %j", async (compiledDirName, message) => {
		await expect(
			buildRegistry({
				sourceDir: path.join(tempDir, "registry"),
				outDir: tempDir,
				compiledDirName,
			}),
		).rejects.toThrow(message);
	});

	it("rejects typesFileName that escapes the registry source", async () => {
		await expect(
			buildRegistry({
				sourceDir: path.join(tempDir, "registry"),
				outDir: tempDir,
				typesFileName: "../outside.json",
			}),
		).rejects.toThrow("typesFileName");
	});

	it("rejects empty bundleExternalPackages entries", async () => {
		await expect(
			buildRegistry({
				sourceDir: path.join(tempDir, "registry"),
				outDir: tempDir,
				bundleExternalPackages: ["  "],
			}),
		).rejects.toThrow("bundleExternalPackages entries must be non-empty.");
	});

	it("still rejects @pebbles/core runtime imports when bundleExternalPackages is empty", async () => {
		writeItem(
			tempDir,
			"configuration/bad-core",
			{
				id: "bad-core",
				title: "Bad core",
				description: "Imports core at runtime",
				type: "configuration",
				beforeWrite: "handler.ts",
			},
			{
				"handler.ts": `
import { parseWithSchema } from "@pebbles/core";
export default async function beforeWrite() {
  void parseWithSchema;
  return { files: [{ target: "X", content: "x" }] };
}
`,
			},
		);

		await expect(
			buildRegistry({
				sourceDir: path.join(tempDir, "registry"),
				outDir: tempDir,
				bundleExternalPackages: [],
			}),
		).rejects.toThrow("@pebbles/core");
	});

	it("rejects install scripts that runtime-import a configured external package", async () => {
		writeItem(
			tempDir,
			"configuration/banned",
			{
				id: "banned",
				title: "Banned",
				description: "Imports a configured external",
				type: "configuration",
				beforeWrite: "handler.ts",
			},
			{
				"handler.ts": `
const value = require.resolve("acme-registry-runtime/subpath");
export default async function beforeWrite() {
  void value;
  return { files: [{ target: "X", content: "x" }] };
}
`,
			},
		);

		await expect(
			buildRegistry({
				sourceDir: path.join(tempDir, "registry"),
				outDir: tempDir,
				bundleExternalPackages: [
					" acme-registry-runtime ",
					"acme-registry-runtime",
				],
			}),
		).rejects.toThrow("acme-registry-runtime");
	});

	it("moves dependencies into payloads and keeps dependsOn in the catalog", async () => {
		writeItem(
			tempDir,
			"configuration/testing",
			{
				id: "testing",
				title: "Testing",
				description: "Tests",
				type: "configuration",
				dependsOn: ["setup-workspace"],
				dependencies: {
					npm: {
						runtime: ["shared-lib"],
						dev: ["vitest"],
					},
				},
				packs: [
					{
						id: "typescript",
						title: "TypeScript",
						when: { language: "typescript" },
						dependsOn: ["setup-workspace-workflow"],
						dependencies: {
							npm: {
								runtime: ["react"],
								dev: ["@vitest/coverage-v8"],
							},
						},
						files: [{ source: "vitest.config.ts", target: "vitest.config.ts" }],
					},
				],
			},
			{ "vitest.config.ts": "export default {};\n" },
		);
		writeRegistryJson(tempDir, "conditions/conditions.json", {
			language: {
				kind: "select",
				label: "Language",
				values: [{ value: "typescript", label: "TypeScript" }],
			},
		});

		const document = await runBuild();
		expect(document.items.testing).toEqual({
			title: "Testing",
			description: "Tests",
			type: "configuration",
			source: "r/testing.json",
			dependsOn: ["setup-workspace"],
			packs: [
				{
					id: "typescript",
					title: "TypeScript",
					source: "r/testing/typescript.json",
					when: { language: "typescript" },
					dependsOn: ["setup-workspace-workflow"],
				},
			],
		});
		expect(document.items.testing).not.toHaveProperty("dependencies");

		const payload = JSON.parse(
			fs.readFileSync(path.join(tempDir, "r/testing/typescript.json"), "utf8"),
		) as CompiledItem;
		expect(payload.dependencies).toEqual({
			npm: {
				runtime: ["react", "shared-lib"],
				dev: ["@vitest/coverage-v8", "vitest"],
			},
		});
		expect(payload).not.toHaveProperty("id");
		expect(payload).not.toHaveProperty("packId");
		expect(payload).not.toHaveProperty("dependsOn");
	});

	it("bundles item install scripts and condition handlers into r/", async () => {
		writeItem(
			tempDir,
			"configuration/license",
			{
				id: "license",
				title: "License",
				description: "SPDX license",
				type: "configuration",
				beforeWrite: "handler.ts",
			},
			{
				"handler.ts": `
export default async function beforeWrite() {
  return { files: [{ target: "LICENSE", content: "MIT" }] };
}
`,
			},
		);
		fs.mkdirSync(path.join(tempDir, "registry/conditions"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(tempDir, "registry/conditions/language.ts"),
			`
export default {
  async infer() {
    return "typescript";
  },
};
`,
			"utf8",
		);
		writeRegistryJson(tempDir, "conditions/conditions.json", {
			language: {
				kind: "select",
				label: "Language",
				handler: "conditions/language.ts",
				values: [{ value: "typescript", label: "TypeScript" }],
			},
		});

		const document = await runBuild();
		expect(document.items.license).toEqual({
			title: "License",
			description: "SPDX license",
			type: "configuration",
			beforeWrite: ["r/license.beforeWrite.0.js"],
		});
		expect(document.items.license).not.toHaveProperty("source");
		expect(document.conditions?.language.handler).toBe(
			"r/_handlers/language.handler.js",
		);
		expect(
			fs.existsSync(path.join(tempDir, "r/license.beforeWrite.0.js")),
		).toBe(true);
		expect(
			fs.existsSync(path.join(tempDir, "r/_handlers/language.handler.js")),
		).toBe(true);
		expect(fs.existsSync(path.join(tempDir, "r/license.json"))).toBe(false);
		expect(document.scriptIntegrity?.["r/license.beforeWrite.0.js"]).toMatch(
			/^sha256-/,
		);
		expect(
			document.scriptIntegrity?.["r/_handlers/language.handler.js"],
		).toMatch(/^sha256-/);
	});

	it("writes a payload for a script item that declares packages", async () => {
		writeItem(
			tempDir,
			"configuration/with-pkgs",
			{
				id: "with-pkgs",
				title: "With packages",
				description: "Install script plus packages",
				type: "configuration",
				beforeWrite: "handler.ts",
				dependencies: {
					npm: {
						runtime: ["left-pad"],
					},
				},
			},
			{
				"handler.ts": `
export default async function beforeWrite() {
  return { files: [{ target: "X", content: "x" }] };
}
`,
			},
		);

		const document = await runBuild();
		expect(document.items["with-pkgs"]).toEqual({
			title: "With packages",
			description: "Install script plus packages",
			type: "configuration",
			source: "r/with-pkgs.json",
			beforeWrite: ["r/with-pkgs.beforeWrite.0.js"],
		});

		const payload = JSON.parse(
			fs.readFileSync(path.join(tempDir, "r/with-pkgs.json"), "utf8"),
		) as CompiledItem;
		expect(payload).toEqual({
			files: [],
			dependencies: {
				npm: {
					runtime: ["left-pad"],
				},
			},
		});
		expect(
			fs.existsSync(path.join(tempDir, "r/with-pkgs.beforeWrite.0.js")),
		).toBe(true);
	});

	it("rejects install scripts that runtime-import @pebbles/core", async () => {
		writeItem(
			tempDir,
			"configuration/bad",
			{
				id: "bad",
				title: "Bad",
				description: "Imports core at runtime",
				type: "configuration",
				beforeWrite: "handler.ts",
			},
			{
				"handler.ts": `
import { parseWithSchema } from "@pebbles/core";
export default async function beforeWrite() {
  void parseWithSchema;
  return { files: [{ target: "X", content: "x" }] };
}
`,
			},
		);

		await expect(runBuild()).rejects.toThrow("@pebbles/core");
	});

	it("rejects a declared install script file that is missing", async () => {
		writeItem(
			tempDir,
			"configuration/missing-handler",
			{
				id: "missing-handler",
				title: "Missing script",
				description: "Points at a missing script",
				type: "configuration",
				beforeWrite: "handler.ts",
				files: [{ source: "a.txt", target: "a.txt" }],
			},
			{
				"a.txt": "hello\n",
			},
		);

		await expect(runBuild()).rejects.toThrow("missing script");
	});

	it("bundles an install script that lives in a parent folder of the item", async () => {
		writeItem(
			tempDir,
			"configuration/license",
			{
				id: "license",
				title: "License",
				description: "SPDX license",
				type: "configuration",
				beforeWrite: "../shared.before-write.ts",
			},
			{},
		);
		fs.writeFileSync(
			path.join(tempDir, "registry/configuration/shared.before-write.ts"),
			'export default async function beforeWrite() { return { bindings: { ok: "1" } }; }\n',
		);

		const document = await runBuild();
		expect(document.items.license.beforeWrite).toEqual([
			"r/license.beforeWrite.0.js",
		]);
		expect(
			fs.existsSync(path.join(tempDir, "r/license.beforeWrite.0.js")),
		).toBe(true);
	});

	it("rejects an install script that escapes the registry source", async () => {
		writeItem(
			tempDir,
			"configuration/nested/license",
			{
				id: "license",
				title: "License",
				description: "Escaping script",
				type: "configuration",
				beforeWrite: "../../../../outside.ts",
			},
			{},
		);

		await expect(runBuild()).rejects.toThrow(
			'Registry item "license" beforeWrite script "../../../../outside.ts" escapes the registry source.',
		);
	});

	it("rejects an install script that fails to bundle", async () => {
		writeItem(
			tempDir,
			"configuration/syntax-error",
			{
				id: "syntax-error",
				title: "Syntax error",
				description: "Invalid TypeScript install script",
				type: "configuration",
				beforeWrite: "handler.ts",
			},
			{
				"handler.ts":
					"export default async function beforeWrite() { return [[[; };\n",
			},
		);

		await expect(runBuild()).rejects.toThrow("Failed to bundle");
	});

	it("preserves item requires in the catalog", async () => {
		writeRegistryJson(tempDir, "conditions/conditions.json", {
			language: {
				kind: "select",
				label: "Language",
				values: [{ value: "typescript", label: "TypeScript" }],
			},
		});
		writeItem(
			tempDir,
			"configuration/requires-lang",
			{
				id: "requires-lang",
				title: "Requires language",
				description: "Declares requires",
				type: "configuration",
				requires: ["language"],
				files: [{ source: "a.txt", target: "a.txt" }],
			},
			{ "a.txt": "hello\n" },
		);

		const document = await runBuild();
		expect(document.items["requires-lang"].requires).toEqual(["language"]);
	});

	it("folds item and pack commands and secrets into the payload", async () => {
		writeItem(
			tempDir,
			"configuration/scripts",
			{
				id: "scripts",
				title: "Scripts",
				description: "Commands and secrets",
				type: "configuration",
				commands: { npm: { test: "vitest run" } },
				secrets: ["GH_ADMIN_TOKEN"],
				packs: [
					{
						id: "typescript",
						title: "TypeScript",
						commands: { npm: { cov: "vitest run --coverage" } },
						secrets: ["SONAR_TOKEN"],
						files: [{ source: "a.txt", target: "a.txt" }],
					},
				],
			},
			{ "a.txt": "ok\n" },
		);

		await runBuild();
		const payload = JSON.parse(
			fs.readFileSync(path.join(tempDir, "r/scripts/typescript.json"), "utf8"),
		) as CompiledItem;

		expect(payload.commands).toEqual({
			npm: { test: "vitest run", cov: "vitest run --coverage" },
		});
		expect(payload.secrets).toEqual(["GH_ADMIN_TOKEN", "SONAR_TOKEN"]);
	});

	it("compiles item-level condition handlers into r/_handlers/items", async () => {
		writeItem(
			tempDir,
			"configuration/local-cond",
			{
				id: "local-cond",
				title: "Local",
				description: "Item condition handler",
				type: "configuration",
				conditions: {
					coverageThreshold: {
						kind: "text",
						label: "Coverage",
						handler: "coverage.ts",
					},
				},
				files: [{ source: "a.txt", target: "a.txt" }],
			},
			{
				"a.txt": "ok\n",
				"coverage.ts": "export default { async infer() { return '45'; } };\n",
			},
		);

		const document = await runBuild();
		expect(document.items["local-cond"].conditions?.coverageThreshold).toEqual({
			kind: "text",
			label: "Coverage",
			handler: "r/_handlers/items/local-cond/coverageThreshold.handler.js",
		});
		expect(
			fs.existsSync(
				path.join(
					tempDir,
					"r/_handlers/items/local-cond/coverageThreshold.handler.js",
				),
			),
		).toBe(true);
	});

	it("compiles item-level and pack-level afterInstall scripts", async () => {
		writeItem(
			tempDir,
			"configuration/lifecycle",
			{
				id: "lifecycle",
				title: "Lifecycle",
				description: "Install lifecycle scripts",
				type: "configuration",
				afterInstall: "after.ts",
				packs: [
					{
						id: "pro",
						title: "Pro",
						afterInstall: "pro-after.ts",
						files: [{ source: "pro.txt", target: "pro.txt" }],
					},
				],
			},
			{
				"after.ts": `export default async function afterInstall() {}\n`,
				"pro-after.ts": `export default async function afterInstall() {}\n`,
				"pro.txt": "pro\n",
			},
		);

		const document = await runBuild();
		expect(document.items.lifecycle.afterInstall).toEqual([
			"r/lifecycle.afterInstall.0.js",
		]);
		expect(document.items.lifecycle.packs).toEqual([
			expect.objectContaining({
				id: "pro",
				afterInstall: ["r/lifecycle/pro.afterInstall.0.js"],
			}),
		]);
		expect(
			fs.existsSync(path.join(tempDir, "r/lifecycle.afterInstall.0.js")),
		).toBe(true);
		expect(
			fs.existsSync(path.join(tempDir, "r/lifecycle/pro.afterInstall.0.js")),
		).toBe(true);
	});

	it("namespaces pack install scripts under r/{itemId}/{packId}", async () => {
		writeItem(
			tempDir,
			"component/button",
			{
				id: "button",
				title: "Button",
				description: "Button component",
				type: "component",
				beforeWrite: "shared.ts",
				packs: [
					{
						id: "react",
						title: "React",
						beforeWrite: "react.ts",
						files: [{ source: "react.tsx", target: "button.tsx" }],
					},
					{
						id: "vue",
						title: "Vue",
						beforeWrite: "vue.ts",
						files: [{ source: "vue.vue", target: "button.vue" }],
					},
				],
			},
			{
				"shared.ts": `export default async function beforeWrite() { return { files: [] }; }\n`,
				"react.ts": `export default async function beforeWrite() { return { files: [] }; }\n`,
				"vue.ts": `export default async function beforeWrite() { return { files: [] }; }\n`,
				"react.tsx": "export {}\n",
				"vue.vue": "<template></template>\n",
			},
		);

		const document = await runBuild();
		expect(document.items.button.beforeWrite).toEqual([
			"r/button.beforeWrite.0.js",
		]);
		expect(document.items.button.packs).toEqual([
			expect.objectContaining({
				id: "react",
				beforeWrite: ["r/button/react.beforeWrite.0.js"],
			}),
			expect.objectContaining({
				id: "vue",
				beforeWrite: ["r/button/vue.beforeWrite.0.js"],
			}),
		]);
		expect(fs.existsSync(path.join(tempDir, "r/button.beforeWrite.0.js"))).toBe(
			true,
		);
		expect(
			fs.existsSync(path.join(tempDir, "r/button/react.beforeWrite.0.js")),
		).toBe(true);
		expect(
			fs.existsSync(path.join(tempDir, "r/button/vue.beforeWrite.0.js")),
		).toBe(true);
	});

	it("copies dependsOn into the index without treating them as scripts", async () => {
		writeItem(
			tempDir,
			"template/react-app",
			{
				id: "react-app",
				title: "React App",
				description: "React template",
				type: "component",
				dependsOn: ["license-configuration", "git-init"],
				files: [{ source: "README.md", target: "README.md" }],
			},
			{ "README.md": "# App\n" },
		);

		const document = await runBuild();
		expect(document.items["react-app"]).toMatchObject({
			dependsOn: ["license-configuration", "git-init"],
		});
		expect(document.items["react-app"]).not.toHaveProperty("beforeWrite");
		expect(document.items["react-app"]).not.toHaveProperty("afterInstall");
	});

	it("writes a base payload when an item declares commands without files", async () => {
		writeItem(
			tempDir,
			"configuration/scripts-only",
			{
				id: "scripts-only",
				title: "Scripts only",
				description: "Commands without files",
				type: "configuration",
				afterInstall: "after.ts",
				commands: { npm: { test: "vitest run" } },
			},
			{
				"after.ts": `export default async function afterInstall() {}\n`,
			},
		);

		const document = await runBuild();
		expect(document.items["scripts-only"].source).toBe("r/scripts-only.json");
		const payload = JSON.parse(
			fs.readFileSync(path.join(tempDir, "r/scripts-only.json"), "utf8"),
		) as CompiledItem;
		expect(payload).toEqual({
			files: [],
			commands: { npm: { test: "vitest run" } },
		});
	});

	it("writes a base payload when an item declares secrets without files", async () => {
		writeItem(
			tempDir,
			"configuration/secrets-only",
			{
				id: "secrets-only",
				title: "Secrets only",
				description: "Secrets without files",
				type: "configuration",
				afterInstall: "after.ts",
				secrets: ["GH_ADMIN_TOKEN"],
			},
			{
				"after.ts": `export default async function afterInstall() {}\n`,
			},
		);

		const document = await runBuild();
		expect(document.items["secrets-only"].source).toBe("r/secrets-only.json");
		const payload = JSON.parse(
			fs.readFileSync(path.join(tempDir, "r/secrets-only.json"), "utf8"),
		) as CompiledItem;
		expect(payload).toEqual({
			files: [],
			secrets: ["GH_ADMIN_TOKEN"],
		});
	});

	it("allows npm dependencies without a packageManager condition", async () => {
		writeItem(
			tempDir,
			"component/button",
			{
				id: "button",
				title: "Button",
				description: "A button",
				type: "component",
				files: [{ source: "a.txt", target: "a.txt" }],
				dependencies: {
					npm: {
						runtime: ["react"],
					},
				},
			},
			{ "a.txt": "ok\n" },
		);

		const document = await runBuild();
		expect(document.items.button.source).toBe("r/button.json");
		const payload = JSON.parse(
			fs.readFileSync(path.join(tempDir, "r/button.json"), "utf8"),
		) as CompiledItem;
		expect(payload.dependencies).toEqual({
			npm: { runtime: ["react"] },
		});
	});

	it("rejects declaring packageManager as a shared condition", async () => {
		writeItem(
			tempDir,
			"component/button",
			{
				id: "button",
				title: "Button",
				description: "A button",
				type: "component",
				files: [{ source: "a.txt", target: "a.txt" }],
			},
			{ "a.txt": "ok\n" },
		);
		writeRegistryJson(tempDir, "conditions/conditions.json", {
			packageManager: {
				kind: "select",
				label: "Package manager",
				values: [{ value: "pnpm", label: "pnpm" }],
			},
		});

		await expect(runBuild()).rejects.toThrow(
			'Registry conditions cannot declare reserved condition "packageManager" (built-in install context).',
		);
	});

	it("rethrows non-ENOENT errors while walking the registry source tree", async () => {
		const blocked = path.join(tempDir, "registry", "blocked");
		fs.mkdirSync(blocked, { recursive: true });
		fs.chmodSync(blocked, 0);

		try {
			await expect(runBuild()).rejects.toThrow();
		} finally {
			fs.chmodSync(blocked, 0o755);
		}
	});
});
