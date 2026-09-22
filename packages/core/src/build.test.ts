import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Registry } from "./index";
import { buildRegistry } from "./index";

let sourceDir: string;
let outDir: string;

beforeEach(() => {
	sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheetos-build-src-"));
	outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cheetos-build-out-"));
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
