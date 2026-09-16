import Mustache from "mustache";
import { describe, expect, it, vi } from "vitest";
import {
	buildInterpolationContext,
	interpolateCompiledItem,
} from "./interpolate";
import { NpmPackageManager } from "./packages";
import { type CompiledItem, RegistryEcosystem } from "./schema";

describe("core/interpolate", () => {
	describe("buildInterpolationContext", () => {
		it("keeps typed conditions, merges select option bindings, and injects package-manager keys", () => {
			expect(
				buildInterpolationContext({
					conditions: {
						defaultBranch: "main",
						enableCi: true,
						tags: ["ios", "web"],
						skipped: undefined,
					},
					hookBindings: { sonarProjectKey: "org_app" },
					optionValues: {
						defaultBranch: [
							{
								value: "main",
								label: "main",
								bindings: { sonarHost: "https://sonar.example" },
							},
						],
					},
					packageManager: NpmPackageManager.PNPM,
					ecosystem: RegistryEcosystem.NPM,
				}),
			).toEqual({
				defaultBranch: "main",
				enableCi: true,
				tags: ["ios", "web"],
				packageManager: "pnpm",
				pmRun: "pnpm",
				pmExec: "pnpm exec",
				pmInstall: "pnpm install",
				pmInstallCi: "pnpm install --ignore-scripts --frozen-lockfile",
				pmPublish:
					"pnpm -r publish --provenance --access public --no-git-checks",
				sonarHost: "https://sonar.example",
				sonarProjectKey: "org_app",
			});
		});

		it("lets hook bindings win over extra option keys", () => {
			expect(
				buildInterpolationContext({
					conditions: { defaultBranch: "main" },
					hookBindings: { sonarProjectKey: "from-hook" },
					optionValues: {
						defaultBranch: [
							{
								value: "main",
								label: "main",
								bindings: { sonarProjectKey: "from-option" },
							},
						],
					},
				}),
			).toEqual({
				defaultBranch: "main",
				sonarProjectKey: "from-hook",
			});
		});

		it("omits skipped optionals from the view", () => {
			expect(
				buildInterpolationContext({ conditions: { skipped: undefined } }),
			).toEqual({});
		});

		it("does not seed option bindings for an unmatched or unknown captured value", () => {
			expect(
				buildInterpolationContext({
					conditions: { toolchain: "cargo" },
					optionValues: {
						toolchain: [
							{
								value: "pnpm",
								label: "pnpm",
								bindings: { sonarHost: "https://sonar.example" },
							},
						],
					},
				}),
			).toEqual({ toolchain: "cargo" });
		});

		it("throws when packageManager is set without an ecosystem", () => {
			expect(() =>
				buildInterpolationContext({
					conditions: {},
					packageManager: NpmPackageManager.PNPM,
				}),
			).toThrow(
				"buildInterpolationContext requires ecosystem when packageManager is set.",
			);
		});

		it("throws when option bindings reuse a condition key", () => {
			expect(() =>
				buildInterpolationContext({
					conditions: { defaultBranch: "main", language: "typescript" },
					optionValues: {
						language: [
							{
								value: "typescript",
								label: "TypeScript",
								bindings: { defaultBranch: "develop" },
							},
						],
					},
				}),
			).toThrow(
				'Select option binding "defaultBranch" collides with a condition key.',
			);
		});

		it("throws when option bindings reuse a reserved package-manager key", () => {
			expect(() =>
				buildInterpolationContext({
					conditions: { language: "typescript" },
					optionValues: {
						language: [
							{
								value: "typescript",
								label: "TypeScript",
								bindings: { pmExec: "npx" },
							},
						],
					},
				}),
			).toThrow('Select option binding "pmExec" is reserved.');
		});

		it("throws when hook bindings reuse a condition key", () => {
			expect(() =>
				buildInterpolationContext({
					conditions: { defaultBranch: "main" },
					hookBindings: { defaultBranch: "develop" },
				}),
			).toThrow(
				'beforeWrite hook binding "defaultBranch" collides with a condition key.',
			);
		});

		it("throws when hook bindings reuse a reserved package-manager key", () => {
			expect(() =>
				buildInterpolationContext({
					conditions: {},
					hookBindings: { packageManager: "yarn" },
				}),
			).toThrow('beforeWrite hook binding "packageManager" is reserved.');
		});
	});

	describe("interpolateCompiledItem", () => {
		it("replaces {{key}} in files and commands without touching GitHub Actions expressions", () => {
			const ghaSha = `\${{ github.sha }}`;
			const payload = interpolateCompiledItem(
				{
					files: [
						{
							target: "{{projectName}}/ci.yml",
							content: `branch: {{defaultBranch}}\nsha: ${ghaSha}\nrun: {{pmRun}} test\n`,
						},
					],
					commands: { npm: { test: "{{pmExec}} vitest run" } },
				},
				{
					defaultBranch: "main",
					projectName: "my-package",
					pmRun: "pnpm",
					pmExec: "pnpm exec",
				},
			);

			expect(payload.files[0].content).toBe(
				`branch: main\nsha: ${ghaSha}\nrun: pnpm test\n`,
			);
			expect(payload.files[0].target).toBe("my-package/ci.yml");
			expect(payload.commands).toEqual({
				npm: { test: "pnpm exec vitest run" },
			});
		});

		it("treats boolean and array conditions as typed Mustache sections", () => {
			expect(
				interpolateCompiledItem(
					{
						files: [
							{
								target: "a.txt",
								content:
									"{{#enableCi}}ci{{/enableCi}}{{^enableCi}}no-ci{{/enableCi}}\n{{#tags}}{{.}} {{/tags}}",
							},
						],
					},
					{ enableCi: false, tags: ["ios", "web"] },
				).files[0].content,
			).toBe("no-ci\nios web ");
		});

		it("allows absent keys as Mustache sections and throws on missing name tags", () => {
			expect(
				interpolateCompiledItem(
					{
						files: [
							{
								target: "a.txt",
								content:
									"{{#enforcementContact}}contact{{/enforcementContact}}",
							},
						],
					},
					{},
				).files[0].content,
			).toBe("");
			expect(() =>
				interpolateCompiledItem(
					{ files: [{ target: "a.txt", content: "n={{missing}}" }] },
					{},
				),
			).toThrow('Unknown interpolation key "missing" in file "a.txt".');
			expect(
				interpolateCompiledItem(
					{ files: [{ target: "a.txt", content: "n={{empty}}" }] },
					{ empty: "" },
				).files[0].content,
			).toBe("n=");
		});

		it("throws when a command template names a missing key", () => {
			expect(() =>
				interpolateCompiledItem(
					{
						files: [],
						commands: { npm: { test: "{{pmExac}} vitest" } },
					},
					{ pmExec: "pnpm exec" },
				),
			).toThrow('Unknown interpolation key "pmExac" in command "npm.test".');
		});

		it("throws on Mustache partial tags", () => {
			expect(() =>
				interpolateCompiledItem(
					{ files: [{ target: "a.txt", content: "{{>partial}}" }] },
					{},
				),
			).toThrow('Unknown interpolation partial "partial" in file "a.txt".');
		});

		it("throws on a bare Mustache dot outside a section", () => {
			expect(() =>
				interpolateCompiledItem(
					{ files: [{ target: "a.txt", content: "{{.}}" }] },
					{},
				),
			).toThrow('Unknown interpolation key "." in file "a.txt".');
		});

		it("throws on an unhandled Mustache tag type", () => {
			vi.spyOn(Mustache, "parse").mockReturnValueOnce([
				["???", "x", 0, 1] as never,
			]);
			expect(() =>
				interpolateCompiledItem(
					{ files: [{ target: "a.txt", content: "{{x}}" }] },
					{ x: "1" },
				),
			).toThrow('Unhandled Mustache tag type "???" in file "a.txt".');
		});

		it("does not HTML-escape interpolated values", () => {
			expect(
				interpolateCompiledItem(
					{
						files: [
							{
								target: "a.txt",
								content: "name={{authorName}}\nraw={{{authorName}}}",
							},
						],
					},
					{ authorName: "Ada & Bob <dev>" },
				).files[0].content,
			).toBe("name=Ada & Bob <dev>\nraw=Ada & Bob <dev>");
		});

		it("skips undefined command sets and still interpolates defined ecosystems", () => {
			expect(
				interpolateCompiledItem(
					{
						files: [],
						commands: {
							npm: { test: "{{pmExec}} vitest" },
							pypi: undefined,
						} as CompiledItem["commands"],
					},
					{ pmExec: "pnpm exec" },
				).commands,
			).toEqual({ npm: { test: "pnpm exec vitest" } });
		});
	});
});
