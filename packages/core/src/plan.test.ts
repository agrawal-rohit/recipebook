import { describe, expect, test } from "vitest";
import {
	assumeContextFromSelectedItems,
	buildInstallPlan,
	catalogNeedsPackageManager,
	collectDeclaredScriptUris,
	collectItemLocalConditions,
	collectRegistryDependencies,
	collectRequiredConditions,
	collectRequiredConditionWave,
	type IndexEntry,
	type IndexItem,
	type IndexPack,
	NpmPackageManager,
	packageManagerDropsCandidateDependsOn,
	packWhenUsesCapturedKeys,
	parseItemId,
	type Registry,
	type RegistryCondition,
	RegistryConditionKind,
	uniqueKnownRegistryItems,
} from "./index";
import { whenMatchesContext } from "./plan";

function item(overrides: Partial<IndexItem> = {}): IndexItem {
	return {
		title: "Button",
		description: "A button component",
		type: "component",
		...overrides,
	};
}

function pack(id: string, overrides: Partial<IndexPack> = {}): IndexPack {
	return { id, title: id, source: `r/${id}.json`, ...overrides };
}

function condition(
	overrides: Partial<RegistryCondition> = {},
): RegistryCondition {
	return {
		label: "Framework",
		kind: RegistryConditionKind.SELECT,
		values: [
			{ value: "react", label: "React" },
			{ value: "vue", label: "Vue" },
		],
		...overrides,
	};
}

function entry(itemId: string, overrides: Partial<IndexItem> = {}): IndexEntry {
	return { itemId, item: item(overrides) };
}

describe("parseItemId", () => {
	test("it should parse a plain id and an id@pack pin because both forms select items", () => {
		expect(parseItemId("button")).toEqual({ id: "button" });
		expect(parseItemId("button@react")).toEqual({
			id: "button",
			packId: "react",
		});
	});

	test("it should reject empty, dangling, and multi-pin forms because selection needs unambiguous tokens", () => {
		expect(() => parseItemId("")).toThrowError(
			"Registry item id must be non-empty.",
		);
		for (const bad of ["@x", "x@", "a@b@c"]) {
			expect(() => parseItemId(bad)).toThrowError(/expected id or id@pack/);
		}
	});

	test("it should reject prototype-polluting and separator-bearing tokens because ids become payload paths", () => {
		expect(() => parseItemId("__proto__")).toThrowError(
			'Registry item id "__proto__" is not allowed.',
		);
		expect(() => parseItemId("button@__proto__")).toThrowError(
			'Registry pack id "__proto__" is not allowed.',
		);
		expect(() => parseItemId("a/b")).toThrowError(
			/Registry item id "a\/b" must be a single path segment/,
		);
		expect(() => parseItemId("button@vue/next")).toThrowError(
			/Registry pack id "vue\/next" must be a single path segment/,
		);
	});
});

describe("buildInstallPlan install order", () => {
	test("it should return one node with sources for a pack-less item because simple items install one payload", () => {
		expect(
			buildInstallPlan(
				["button"],
				{ button: item({ source: "r/button.json" }) },
				{},
			),
		).toEqual([{ itemId: "button", sources: ["r/button.json"] }]);
	});

	test("it should visit dependsOn targets before their dependent because dependencies must install first", () => {
		const items = {
			app: item({ source: "r/app.json", dependsOn: ["lib"] }),
			lib: item({ source: "r/lib.json" }),
		};
		expect(buildInstallPlan(["app"], items, {})).toEqual([
			{ itemId: "lib", sources: ["r/lib.json"] },
			{ itemId: "app", sources: ["r/app.json"] },
		]);
	});

	test("it should keep script URIs on scripts-only items because side-effect items have no payload source", () => {
		const items = {
			setup: item({ beforeWrite: ["r/setup.js"] }),
		};
		expect(buildInstallPlan(["setup"], items, {})).toEqual([
			{ itemId: "setup", beforeWriteScripts: ["r/setup.js"] },
		]);
	});
});

describe("buildInstallPlan pack selection", () => {
	const buttonWithPacks = item({
		source: "r/button.json",
		packs: [
			pack("react", { when: { framework: "react" } }),
			pack("vue", { when: { framework: "vue" } }),
		],
	});

	test("it should select packs whose when matches the context because matching packs layer on the base item", () => {
		expect(
			buildInstallPlan(
				["button"],
				{ button: buttonWithPacks },
				{ framework: "react" },
			),
		).toEqual([
			{
				itemId: "button",
				packIds: ["react"],
				sources: ["r/button.json", "r/react.json"],
			},
		]);
	});

	test("it should fall back to the base source alone when no pack matches because optional overlays must not block installs", () => {
		expect(
			buildInstallPlan(
				["button"],
				{ button: buttonWithPacks },
				{ framework: "svelte" },
			),
		).toEqual([{ itemId: "button", sources: ["r/button.json"] }]);
	});

	test("it should match array when values against multiselect context by intersection because any listed value satisfies the matcher", () => {
		const packsItem = item({
			source: "r/button.json",
			packs: [pack("lint", { when: { extras: ["lint", "format"] } })],
		});
		expect(
			buildInstallPlan(
				["button"],
				{ button: packsItem },
				{ extras: ["lint", "docs"] },
			),
		).toEqual([
			{
				itemId: "button",
				packIds: ["lint"],
				sources: ["r/button.json", "r/lint.json"],
			},
		]);
		expect(
			buildInstallPlan(["button"], { button: packsItem }, { extras: ["docs"] }),
		).toEqual([{ itemId: "button", sources: ["r/button.json"] }]);
	});
});

describe("buildInstallPlan failures", () => {
	test("it should reject a missing item because the plan cannot install an unknown id", () => {
		expect(() => buildInstallPlan(["ghost"], {}, {})).toThrowError(
			'Registry item not found: "ghost".',
		);
	});

	test("it should reject a dependency cycle because circular installs never terminate", () => {
		const items = {
			a: item({ source: "r/a.json", dependsOn: ["b"] }),
			b: item({ source: "r/b.json", dependsOn: ["a"] }),
		};
		expect(() => buildInstallPlan(["a"], items, {})).toThrowError(
			/dependency cycle detected/,
		);
		expect(() => collectRegistryDependencies(["a"], items)).toThrowError(
			/dependency cycle detected/,
		);
	});

	test("it should reject two matching packs with identical when because the runtime cannot tell them apart", () => {
		const ambiguous = item({
			packs: [pack("first"), pack("second")],
		});
		expect(() =>
			buildInstallPlan(["button"], { button: ambiguous }, {}),
		).toThrowError(/selected indistinguishable packs/);
	});

	test("it should reject a packed item with no matching pack and no base payload because it would install nothing", () => {
		const gated = item({
			packs: [pack("react", { when: { framework: "react" } })],
		});
		expect(() =>
			buildInstallPlan(["button"], { button: gated }, {}),
		).toThrowError(/has packs but none match the current install context\./);
	});

	test("it should reject a second pin that conflicts with the first selection because one item cannot install two disjoint packs", () => {
		const items = {
			button: item({
				packs: [
					pack("react", { when: { framework: "react" } }),
					pack("vue", { when: { framework: "vue" } }),
				],
			}),
		};
		expect(() =>
			buildInstallPlan(["button@react", "button@vue"], items, {
				framework: "react",
			}),
		).toThrowError(/selected conflicting packs/);
	});

	test("it should reject a pin on a pack-less item and a pin naming an unknown pack because pins must reference real packs", () => {
		expect(() =>
			buildInstallPlan(
				["button@react"],
				{ button: item({ source: "r/button.json" }) },
				{},
			),
		).toThrowError('Registry item "button" has no packs.');
		expect(() =>
			buildInstallPlan(
				["button@unknown"],
				{ button: item({ packs: [pack("react")] }) },
				{},
			),
		).toThrowError('Registry item "button" has no pack "unknown".');
	});
});

describe("packageManager planning", () => {
	const managerItem = item({
		source: "r/button.json",
		packs: [
			pack("pnpm-only", { when: { packageManager: "pnpm" } }),
			pack("npm-only", { when: { packageManager: "npm" } }),
		],
	});

	test("it should select the pack matching the chosen package manager because packs can be manager-specific", () => {
		expect(
			buildInstallPlan(
				["button"],
				{ button: managerItem },
				{},
				NpmPackageManager.PNPM,
			),
		).toEqual([
			{
				itemId: "button",
				packIds: ["pnpm-only"],
				sources: ["r/button.json", "r/pnpm-only.json"],
			},
		]);
	});

	test("it should select only the base source while the package manager is undecided because undecided matchers are mismatches at selection time", () => {
		expect(buildInstallPlan(["button"], { button: managerItem }, {})).toEqual([
			{ itemId: "button", sources: ["r/button.json"] },
		]);
	});

	test("it should detect the package-manager need from pack and shared-condition when clauses because the CLI must ask before pack selection", () => {
		expect(
			catalogNeedsPackageManager([
				entry("button", { packs: managerItem.packs }),
			]),
		).toBe(true);
		expect(
			catalogNeedsPackageManager([], {
				packageManager: condition({ when: { packageManager: "npm" } }),
			}),
		).toBe(true);
		expect(
			catalogNeedsPackageManager([entry("button", { source: "r/x.json" })]),
		).toBe(false);
	});

	test("it should report a dropped dependsOn only when the chosen manager rules out a still-possible pack because candidate walks over-approximate", () => {
		const depItems = {
			button: item({
				packs: [
					pack("npm-only", {
						when: { packageManager: "npm" },
						dependsOn: ["lib"],
					}),
				],
			}),
			lib: item({ source: "r/lib.json" }),
		};
		const entries = collectRegistryDependencies(["button"], depItems, {});
		expect(
			packageManagerDropsCandidateDependsOn(
				entries,
				["button"],
				{},
				NpmPackageManager.PNPM,
			),
		).toBe(true);

		const managerIndependent = {
			button: item({
				packs: [pack("always", { dependsOn: ["lib"] })],
			}),
			lib: item({ source: "r/lib.json" }),
		};
		const plainEntries = collectRegistryDependencies(
			["button"],
			managerIndependent,
			{},
		);
		expect(
			packageManagerDropsCandidateDependsOn(
				plainEntries,
				["button"],
				{},
				NpmPackageManager.PNPM,
			),
		).toBe(false);
	});
});

describe("collectRequiredConditions", () => {
	const framework = condition();
	const extras = condition({
		label: "Extras",
		values: [
			{ value: "lint", label: "Lint" },
			{ value: "format", label: "Format" },
		],
	});

	test("it should return pending conditions sorted by key with select options narrowed to installable values because prompts must stay actionable", () => {
		const entries: IndexEntry[] = [
			entry("alpha", {
				packs: [
					pack("react", { when: { framework: "react" } }),
					pack("vue", { when: { framework: "vue" } }),
				],
			}),
			entry("beta", {
				packs: [pack("lint", { when: { extras: "lint" } })],
			}),
		];
		const required = collectRequiredConditions(
			entries,
			{ extras, framework },
			{},
		);

		expect(required.map((entry) => entry.key)).toEqual(["extras", "framework"]);
		expect(required[0].values.map((value) => value.value)).toEqual(["lint"]);
		expect(required[1].values.map((value) => value.value)).toEqual([
			"react",
			"vue",
		]);
	});

	test("it should throw when narrowing leaves no selectable values because a prompt without options cannot proceed", () => {
		const entries: IndexEntry[] = [
			entry("alpha", {
				packs: [pack("only", { when: { framework: "solid" } })],
			}),
		];
		expect(() =>
			collectRequiredConditions(entries, { framework }, {}),
		).toThrowError(
			'Condition "framework" has no selectable values for the current install set.',
		);
	});

	test("it should skip keys already captured in the context because answered conditions must not prompt twice", () => {
		const entries: IndexEntry[] = [
			entry("alpha", {
				packs: [pack("react", { when: { framework: "react" } })],
			}),
		];
		expect(
			collectRequiredConditions(entries, { framework }, { framework: "react" }),
		).toEqual([]);
	});

	test("it should reject a required key that no condition declares because prompts need definitions", () => {
		expect(() =>
			collectRequiredConditions(
				[entry("alpha", { requires: ["ghost"] })],
				{},
				{},
			),
		).toThrowError('Install plan references undeclared condition "ghost".');
	});

	test("it should never prompt for the reserved packageManager key because core selects it at install time", () => {
		const entries: IndexEntry[] = [
			entry("alpha", {
				packs: [pack("pnpm", { when: { packageManager: "pnpm" } })],
			}),
		];
		expect(collectRequiredConditions(entries, {}, {})).toEqual([]);
	});
});

describe("collectRequiredConditionWave", () => {
	const requires = condition({ label: "Alpha" });
	const waveExtra = condition({
		label: "Extras",
		values: [{ value: "lint", label: "Lint" }],
	});

	test("it should return every pending requires key before any pack-when key because requires answers can drop later when-keys", () => {
		const entries: IndexEntry[] = [
			entry("alpha", { requires: ["alpha1", "alpha2"] }),
			entry("beta", {
				packs: [pack("lint", { when: { extras: "lint" } })],
			}),
		];
		const wave = collectRequiredConditionWave(
			entries,
			{ alpha1: requires, alpha2: requires, extras: waveExtra },
			{},
		);
		expect(wave.map((entry) => entry.key)).toEqual(["alpha1", "alpha2"]);
	});

	test("it should return one pack-when key per wave when no requires are pending because pack gates resolve one answer at a time", () => {
		const entries: IndexEntry[] = [
			entry("beta", {
				packs: [
					pack("lint", { when: { extras: "lint" } }),
					pack("docs", { when: { docs: true } }),
				],
			}),
		];
		const conditions = {
			docs: condition({
				label: "Docs",
				kind: RegistryConditionKind.BOOLEAN,
				values: [],
			}),
			extras: waveExtra,
		};
		const wave = collectRequiredConditionWave(entries, conditions, {});
		expect(wave.map((entry) => entry.key)).toEqual(["docs"]);
	});

	test("it should return an empty wave when every condition is captured because prompting is complete", () => {
		const entries: IndexEntry[] = [
			entry("beta", {
				packs: [pack("lint", { when: { extras: "lint" } })],
			}),
		];
		expect(
			collectRequiredConditionWave(
				entries,
				{ extras: waveExtra },
				{ extras: "lint" },
			),
		).toEqual([]);
	});
});

describe("collectItemLocalConditions", () => {
	test("it should return uncaptured local conditions sorted by key and narrowed to installable values because locals prompt like shared selects", () => {
		const localFramework = condition({ label: "Item framework" });
		const localExtras = condition({
			label: "Item extras",
			values: [
				{ value: "lint", label: "Lint" },
				{ value: "format", label: "Format" },
			],
		});
		const entries: IndexEntry[] = [
			entry("alpha", {
				conditions: { zeta: localFramework },
				packs: [pack("react", { when: { zeta: "react" } })],
			}),
			entry("beta", {
				conditions: { alpha: localExtras },
				packs: [pack("lint", { when: { alpha: "lint" } })],
			}),
		];
		const local = collectItemLocalConditions(entries, {});
		expect(local.map((entry) => entry.key)).toEqual(["alpha", "zeta"]);
		expect(local[0].values.map((value) => value.value)).toEqual(["lint"]);
		expect(local[1].values.map((value) => value.value)).toEqual(["react"]);
	});

	test("it should skip captured locals because prior answers carry into later items", () => {
		const entries: IndexEntry[] = [
			entry("alpha", {
				conditions: { zeta: condition() },
				packs: [pack("react", { when: { zeta: "react" } })],
			}),
		];
		expect(collectItemLocalConditions(entries, { zeta: "react" })).toEqual([]);
	});
});

describe("assumeContextFromSelectedItems", () => {
	test("it should seed select and boolean values from pinned pack when maps because pins imply their conditions", () => {
		const conditions = {
			framework: condition(),
			verbose: condition({
				label: "Verbose",
				kind: RegistryConditionKind.BOOLEAN,
				values: [],
			}),
		};
		const items = {
			button: item({
				packs: [pack("react", { when: { framework: "react", verbose: true } })],
			}),
		};
		expect(
			assumeContextFromSelectedItems(["button@react"], items, conditions),
		).toEqual({ framework: "react", verbose: true });
	});

	test("it should reject two pins demanding conflicting scalar values because one install cannot satisfy both", () => {
		const conditions = { framework: condition() };
		const items = {
			button: item({
				packs: [
					pack("react", { when: { framework: "react" } }),
					pack("vue", { when: { framework: "vue" } }),
				],
			}),
		};
		expect(() =>
			assumeContextFromSelectedItems(
				["button@react", "button@vue"],
				items,
				conditions,
			),
		).toThrowError(
			/Pinned pack "button@vue" requires a conflicting value for condition "framework"\./,
		);
	});

	test("it should reject a pin referencing an undeclared condition because seeded values need definitions", () => {
		const items = {
			button: item({
				packs: [pack("react", { when: { ghost: "react" } })],
			}),
		};
		expect(() =>
			assumeContextFromSelectedItems(["button@react"], items, {}),
		).toThrowError(
			'Pinned pack "button@react" references undeclared condition "ghost".',
		);
	});
});

describe("plan helpers", () => {
	test("uniqueKnownRegistryItems should dedupe tokens first-wins and validate ids and pins because selection must reference real catalog entries", () => {
		const items = {
			button: item({ packs: [pack("react")] }),
		};
		expect(
			uniqueKnownRegistryItems(["button", "button", "button@react"], items),
		).toEqual(["button", "button@react"]);
		expect(() => uniqueKnownRegistryItems(["ghost"], items)).toThrowError(
			'Registry item not found: "ghost".',
		);
		expect(() => uniqueKnownRegistryItems(["button@vue"], items)).toThrowError(
			'Registry item "button" has no pack "vue".',
		);
	});

	test("packWhenUsesCapturedKeys should be true exactly when a captured key appears in a pack when map because only those keys can change selection", () => {
		const entries: IndexEntry[] = [
			entry("alpha", {
				packs: [pack("react", { when: { framework: "react" } })],
			}),
		];
		expect(packWhenUsesCapturedKeys(entries, ["framework"])).toBe(true);
		expect(packWhenUsesCapturedKeys(entries, ["other"])).toBe(false);
		expect(packWhenUsesCapturedKeys(entries, [])).toBe(false);
		expect(
			packWhenUsesCapturedKeys(
				[entry("plain", { source: "r/x.json" })],
				["framework"],
			),
		).toBe(false);
	});
});

describe("collectDeclaredScriptUris", () => {
	const registry: Registry = {
		types: { component: { label: "Components" } },
		conditions: {
			framework: condition({ handler: "r/infer-framework.js" }),
		},
		items: {
			button: item({
				requires: ["framework"],
				source: "r/button.json",
				beforeWrite: ["r/before.js", "r/shared.js"],
				afterInstall: ["r/after.js"],
				conditions: {
					local: condition({ label: "Local", handler: "r/infer-local.js" }),
				},
				packs: [
					pack("react", {
						when: { framework: "react" },
						beforeWrite: ["r/shared.js", "r/pack-before.js"],
					}),
					pack("vue", { when: { framework: "vue" } }),
				],
			}),
		},
	};

	test("it should collect infer URIs from requires handlers, local handlers, and still-possible pack-when keys, deduped and sorted because handlers must run before prompting", () => {
		const { infer, mutation } = collectDeclaredScriptUris(
			registry,
			["button"],
			{
				context: { framework: "react" },
			},
		);
		expect(infer).toEqual(["r/infer-framework.js", "r/infer-local.js"]);
		expect(mutation).toEqual([
			"r/after.js",
			"r/before.js",
			"r/pack-before.js",
			"r/shared.js",
		]);
	});

	test("it should exclude handlers and hooks from packs the context ruled out because irrelevant code must not run", () => {
		const { infer, mutation } = collectDeclaredScriptUris(
			registry,
			["button"],
			{
				context: { framework: "vue" },
			},
		);
		expect(infer).toEqual(["r/infer-framework.js", "r/infer-local.js"]);
		expect(mutation).toEqual(["r/after.js", "r/before.js", "r/shared.js"]);
	});

	test("it should skip the reserved packageManager key when harvesting condition handlers because core owns that condition", () => {
		const pmRegistry = {
			types: { component: { label: "Components" } },
			conditions: {
				packageManager: {
					label: "PM",
					kind: RegistryConditionKind.SELECT,
					handler: "r/infer-pm.js",
					when: { packageManager: "pnpm" },
				},
			},
			items: {
				button: item({
					packs: [pack("pnpm", { when: { packageManager: "pnpm" } })],
				}),
			},
		} as unknown as Registry;
		const { infer, mutation } = collectDeclaredScriptUris(
			pmRegistry,
			["button"],
			{
				context: {},
			},
		);
		expect(infer).toEqual([]);
		expect(mutation).toEqual([]);
	});
});

describe("whenMatchesContext value-type matching", () => {
	test("it should match a boolean context value against a boolean expectation because boolean matchers are scalar", () => {
		expect(whenMatchesContext({ k: true }, { k: true })).toBe(true);
	});

	test("it should not match a boolean context value against a string expectation because types must agree", () => {
		expect(whenMatchesContext({ k: "true" }, { k: true })).toBe(false);
	});

	test("it should match array context values by any shared entry because a multiselect satisfies disjunctive matchers", () => {
		expect(whenMatchesContext({ k: ["b", "z"] }, { k: ["a", "b"] })).toBe(true);
		expect(whenMatchesContext({ k: "a" }, { k: ["a"] })).toBe(true);
		expect(whenMatchesContext({ k: ["a", "b"] }, { k: "a" })).toBe(true);
		expect(whenMatchesContext({ k: "a" }, { k: ["a", "b"] })).toBe(true);
	});

	test("it should not match an undecided key because a missing value cannot satisfy a matcher", () => {
		expect(whenMatchesContext({ k: "a" }, {})).toBe(false);
	});

	test("it should skip undecided keys only when allowUndecided is set because candidate walks tolerate gaps", () => {
		expect(
			whenMatchesContext({ k: "a" }, {}, undefined, { allowUndecided: true }),
		).toBe(true);
	});
});
