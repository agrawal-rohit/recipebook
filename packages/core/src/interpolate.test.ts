import Mustache from "mustache";
import { describe, expect, test, vi } from "vitest";
import {
	buildInterpolationContext,
	type CompiledItem,
	type InterpolationView,
	interpolateCompiledItem,
	NpmPackageManager,
	type RegistryConditionValue,
	type RegistryContextValue,
	RegistryEcosystem,
} from "./index";

function item(
	files: CompiledItem["files"],
	commands?: CompiledItem["commands"],
): CompiledItem {
	return { files, ...(commands ? { commands } : {}) };
}

describe("interpolateCompiledItem", () => {
	test("it should resolve placeholders in targets, contents, and command values because one view drives the whole payload", () => {
		const rendered = interpolateCompiledItem(
			item(
				[
					{
						target: "{{framework}}/component.txt",
						content: "Hello {{framework}}!",
					},
				],
				{ npm: { build: "tsc --project {{framework}}" } },
			),
			{ framework: "react" },
		);
		expect(rendered.files[0].target).toBe("react/component.txt");
		expect(rendered.files[0].content).toBe("Hello react!");
		expect(rendered.commands?.npm?.build).toBe("tsc --project react");
	});

	test("it should reject unknown keys with the file or command subject because typos must fail loudly", () => {
		expect(() =>
			interpolateCompiledItem(
				item([{ target: "a.txt", content: "{{x}}" }]),
				{},
			),
		).toThrowError('Unknown interpolation key "x" in file "a.txt".');
		expect(() =>
			interpolateCompiledItem(
				item([{ target: "{{x}}/a.txt", content: "ok" }]),
				{},
			),
		).toThrowError(
			'Unknown interpolation key "x" in file target "{{x}}/a.txt".',
		);
		expect(() =>
			interpolateCompiledItem(
				item([{ target: "a.txt", content: "ok" }], { npm: { build: "{{x}}" } }),
				{},
			),
		).toThrowError('Unknown interpolation key "x" in command "npm.build".');
	});

	test("it should render values without HTML escaping because YAML, shell, and source files are not HTML", () => {
		expect(
			interpolateCompiledItem(
				item([{ target: "a.txt", content: "{{name}}" }]),
				{ name: "A & B" },
			).files[0].content,
		).toBe("A & B");
	});
});

describe("interpolation sections and syntax", () => {
	const render = (content: string, context: InterpolationView): string =>
		interpolateCompiledItem(item([{ target: "a.txt", content }]), context)
			.files[0].content;

	test("it should render truthy sections and render inverted sections when the key is absent because templates branch on context", () => {
		expect(
			render("{{#lint}}LINT{{/lint}}{{^lint}}NO LINT{{/lint}}", { lint: true }),
		).toBe("LINT");
		expect(render("{{#lint}}LINT{{/lint}}{{^lint}}NO LINT{{/lint}}", {})).toBe(
			"NO LINT",
		);
	});

	test("it should render `{{.}}` only inside a section because bare dots have no context", () => {
		expect(render("{{#items}}{{.}},{{/items}}", { items: ["a", "b"] })).toBe(
			"a,b,",
		);
		expect(() => render("{{.}}", {})).toThrowError(
			'Unknown interpolation key "." in file "a.txt".',
		);
	});

	test("it should reject partials because registry payloads are self-contained", () => {
		expect(() => render("{{> header}}", {})).toThrowError(
			'Unknown interpolation partial "header" in file "a.txt".',
		);
	});

	test("it should preserve GitHub Actions dollar-brace expressions because CI files are not Mustache", () => {
		expect(
			render(`token: \${{ secrets.GITHUB_TOKEN }} {{name}}`, { name: "x" }),
		).toBe(`token: \${{ secrets.GITHUB_TOKEN }} x`);
	});
});

describe("unhandled mustache tag types", () => {
	test("it should throw when Mustache yields an unknown tag type because the walker must fail loudly on parser tokens it cannot classify", () => {
		const spy = vi
			.spyOn(Mustache, "parse")
			.mockReturnValue([["custom", "boom"]] as unknown as ReturnType<
				typeof Mustache.parse
			>);
		try {
			expect(() =>
				interpolateCompiledItem(item([{ target: "a.txt", content: "{{x}}" }]), {
					x: "y",
				}),
			).toThrowError(/Unhandled Mustache tag type "custom"/);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("buildInterpolationContext", () => {
	const reactOption: RegistryConditionValue = {
		value: "react",
		label: "React",
		bindings: { reactBinding: "from-option" },
	};

	test("it should layer conditions, option bindings, package-manager bindings, and hook bindings because one view feeds every template", () => {
		const view = buildInterpolationContext({
			conditions: { framework: "react" },
			optionValues: { framework: [reactOption] },
			packageManager: NpmPackageManager.PNPM,
			ecosystem: RegistryEcosystem.NPM,
			hookBindings: { hookKey: "hook-value" },
		});
		expect(view).toMatchObject({
			framework: "react",
			reactBinding: "from-option",
			packageManager: "pnpm",
			pmRun: "pnpm",
			pmInstallCi: "pnpm install --ignore-scripts --frozen-lockfile",
			hookKey: "hook-value",
		});
	});

	test("it should reject reserved and condition-colliding binding keys because bindings must not shadow the runtime or prompts", () => {
		expect(() =>
			buildInterpolationContext({
				conditions: { framework: "react" },
				hookBindings: { pmRun: "npm run" },
			}),
		).toThrowError('beforeWrite hook binding "pmRun" is reserved.');
		expect(() =>
			buildInterpolationContext({
				conditions: { framework: "react" },
				hookBindings: { framework: "shadow" },
			}),
		).toThrowError(
			'beforeWrite hook binding "framework" collides with a condition key.',
		);
		expect(() =>
			buildInterpolationContext({
				conditions: { framework: "react" },
				optionValues: {
					framework: [
						{ value: "react", label: "React", bindings: { pmExec: "x" } },
					],
				},
			}),
		).toThrowError('Select option binding "pmExec" is reserved.');
	});

	test("it should require an ecosystem when a package manager is set because bindings are ecosystem-specific", () => {
		expect(() =>
			buildInterpolationContext({
				conditions: {},
				packageManager: NpmPackageManager.NPM,
			}),
		).toThrowError(
			"buildInterpolationContext requires ecosystem when packageManager is set.",
		);
	});

	test("it should omit undefined condition values and keep typed arrays and booleans because templates branch on types", () => {
		const view = buildInterpolationContext({
			conditions: {
				pending: undefined,
				extras: ["lint"],
				verbose: true,
			} satisfies Record<string, RegistryContextValue | undefined>,
			optionValues: {
				extras: [{ value: "lint", label: "Lint" }],
			},
		});
		expect(view.pending).toBeUndefined();
		expect(view.extras).toEqual(["lint"]);
		expect(view.verbose).toBe(true);
		expect("packageManager" in view).toBe(false);
	});
});

describe("interpolation syntax edges", () => {
	test("it should reject partial tags because partials are not part of the registry interpolation grammar", () => {
		expect(() =>
			interpolateCompiledItem(
				item([{ target: "a.txt", content: "{{> box}}" }]),
				{},
			),
		).toThrowError('Unknown interpolation partial "box" in file "a.txt".');
	});

	test("it should skip undefined command sets because the commands map may leave ecosystems unset", () => {
		const rendered = interpolateCompiledItem(
			{
				files: [{ target: "a.txt", content: "ok" }],
				commands: { npm: undefined },
			} as unknown as CompiledItem,
			{},
		);
		expect(rendered.commands?.npm).toBeUndefined();
	});
});
