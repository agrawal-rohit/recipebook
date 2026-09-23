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

	test("it should reject a pack-less item with neither a payload source nor install scripts because it would install nothing", () => {
		expect(() =>
			buildInstallPlan(["bare"], { bare: item({}) }, {}),
		).toThrowError(
			'Registry item "bare" is missing a compiled item source or install phase.',
		);
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
	test("it should reject two matching packs whose multi-key when maps are identical because identity comparison must order every when key", () => {
		const multiKeyWhen = { framework: "react", extras: "lint" };
		const ambiguous = item({
			packs: [
				pack("first", { when: { ...multiKeyWhen } }),
				pack("second", { when: { ...multiKeyWhen } }),
			],
		});
		expect(() =>
			buildInstallPlan(
				["button"],
				{ button: ambiguous },
				{ framework: "react", extras: "lint" },
			),
		).toThrowError(/selected indistinguishable packs/);
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

	test("it should include a pinned pack whose when clause does not match the context because an explicit pin overrides condition matching", () => {
		const items = {
			button: item({
				packs: [
					pack("react", { when: { framework: "react" } }),
					pack("vue", { when: { framework: "vue" } }),
				],
			}),
		};
		const plan = buildInstallPlan(["button@vue"], items, {
			framework: "react",
		});
		expect(plan[0].packIds).toEqual(["react", "vue"]);
		expect(plan[0].sources).toEqual(["r/react.json", "r/vue.json"]);
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
		expect(
			catalogNeedsPackageManager([
				entry("button", {
					conditions: {
						pkgManager: condition({ when: { packageManager: "npm" } }),
					},
				}),
			]),
		).toBe(true);
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

	test("it should surface required boolean and text conditions without selectable values because non-select kinds prompt without option lists", () => {
		const strict = condition({
			label: "Strict mode",
			kind: RegistryConditionKind.BOOLEAN,
			values: undefined,
			required: true,
		});
		expect(
			collectRequiredConditions(
				[entry("alpha", { requires: ["strict"] })],
				{ strict },
				{},
			),
		).toEqual([
			{
				key: "strict",
				label: "Strict mode",
				kind: RegistryConditionKind.BOOLEAN,
				values: [],
				required: true,
			},
		]);
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
	test("it should dedupe tokens first-wins and validate ids and pins on uniqueKnownRegistryItems because selection must reference real catalog entries", () => {
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

	test("it should be true exactly when a captured key appears in a pack when map on packWhenUsesCapturedKeys because only those keys can change selection", () => {
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

	test("it should still match decided keys while allowUndecided tolerates gaps because tolerance must not loosen satisfied matchers", () => {
		expect(
			whenMatchesContext({ k: "a" }, { k: "b" }, undefined, {
				allowUndecided: true,
			}),
		).toBe(false);
	});

	test("it should compare the selected package manager against the matcher because pack `when` gates on the runtime choice", () => {
		expect(
			whenMatchesContext(
				{ packageManager: "pnpm" },
				{},
				NpmPackageManager.PNPM,
			),
		).toBe(true);
		expect(
			whenMatchesContext({ packageManager: "pnpm" }, {}, NpmPackageManager.NPM),
		).toBe(false);
	});
});

describe("buildInstallPlan selection output shapes", () => {
	test("it should emit afterInstallScripts for scripts-only items because post-install hooks need a payload channel", () => {
		expect(
			buildInstallPlan(
				["post"],
				{ post: item({ afterInstall: ["r/after.js"] }) },
				{},
			),
		).toEqual([{ itemId: "post", afterInstallScripts: ["r/after.js"] }]);
	});

	test("it should omit packIds when a packed item matches no pack because an empty overlay list is not a selection", () => {
		const gated = item({
			source: "r/button.json",
			packs: [pack("react", { when: { framework: "react" } })],
		});
		expect(
			buildInstallPlan(["button"], { button: gated }, { framework: "vue" }),
		).toEqual([{ itemId: "button", sources: ["r/button.json"] }]);
	});
});

describe("collectPresentWhenValues shapes", () => {
	test("it should register a boolean when key as a valueless condition because boolean packs still need prompting", () => {
		const entries: IndexEntry[] = [
			entry("alpha", {
				packs: [pack("docs", { when: { docs: true } })],
			}),
		];
		expect(
			collectRequiredConditions(
				entries,
				{
					docs: condition({
						label: "Docs",
						kind: RegistryConditionKind.BOOLEAN,
						values: [],
					}),
				},
				{},
			),
		).toEqual([
			{
				key: "docs",
				label: "Docs",
				kind: RegistryConditionKind.BOOLEAN,
				values: [],
			},
		]);
	});

	test("it should register multiselect when values by collecting list entries because any listed value keeps the pack possible", () => {
		const multi = condition({
			label: "Extras",
			kind: RegistryConditionKind.MULTISELECT,
			values: [
				{ value: "lint", label: "Lint" },
				{ value: "format", label: "Format" },
				{ value: "docs", label: "Docs" },
			],
		});
		const entries: IndexEntry[] = [
			entry("alpha", {
				packs: [
					pack("lint", { when: { extras: ["lint", "docs"] } }),
					pack("fmt", { when: { extras: ["format"] } }),
				],
			}),
		];
		const required = collectRequiredConditions(entries, { extras: multi }, {});
		expect(required.map((entry) => entry.key)).toEqual(["extras"]);
		expect(required[0].values.map((value) => value.value)).toEqual([
			"lint",
			"format",
			"docs",
		]);
	});
});

describe("collectDeclaredScriptUris filter arms", () => {
	const handlerRegistry: Registry = {
		types: { component: { label: "Components" } },
		conditions: {
			bare: condition({ label: "Bare" }),
		},
		items: {
			button: item({
				requires: ["bare"],
				packs: [pack("react", { when: { bare: "x" } })],
			}),
		},
	};

	test("it should harvest only handler-bearing conditions from requires and pack-when keys because handler-less conditions are prompt-only", () => {
		const { infer, mutation } = collectDeclaredScriptUris(
			handlerRegistry,
			["button"],
			{ context: {} },
		);
		expect(infer).toEqual([]);
		expect(mutation).toEqual([]);
		const withHandler: Registry = {
			...handlerRegistry,
			conditions: {
				...handlerRegistry.conditions,
				bare: condition({ label: "Bare", handler: "r/infer-bare.js" }),
			},
		};
		expect(
			collectDeclaredScriptUris(withHandler, ["button"], { context: {} }).infer,
		).toEqual(["r/infer-bare.js"]);
	});

	test("it should skip handlers whose condition when fails because ruled-out inferers must not run", () => {
		const gated: Registry = {
			types: { component: { label: "Components" } },
			conditions: {
				framework: condition({
					handler: "r/infer-framework.js",
					when: { stage: "prod" },
				}),
				stage: condition({ label: "Stage" }),
			},
			items: {
				button: item({
					packs: [pack("react", { when: { framework: "react" } })],
				}),
			},
		};
		expect(
			collectDeclaredScriptUris(gated, ["button"], {
				context: { stage: "dev" },
			}).infer,
		).toEqual([]);
		expect(
			collectDeclaredScriptUris(gated, ["button"], {
				context: { stage: "prod" },
			}).infer,
		).toEqual(["r/infer-framework.js"]);
	});

	test("it should default the context to empty and skip items missing from the registry because options are optional and ids may be stale", () => {
		const withItem: Registry = {
			types: { component: { label: "Components" } },
			conditions: { framework: condition({ handler: "r/infer.js" }) },
			items: {
				button: item({ requires: ["framework"] }),
			},
		};
		expect(collectDeclaredScriptUris(withItem, ["button"])).toEqual({
			infer: ["r/infer.js"],
			mutation: [],
		});
		expect(collectDeclaredScriptUris(withItem, ["ghost"])).toEqual({
			infer: [],
			mutation: [],
		});
	});
});

describe("collectRegistryDependencies candidate closure", () => {
	test("it should include item-level dependsOn and skip deps of context-ruled-out packs because the closure must stay installable", () => {
		const items = {
			button: item({
				packs: [
					pack("react", {
						when: { framework: "react" },
						dependsOn: ["react-dep"],
					}),
					pack("vue", { when: { framework: "vue" }, dependsOn: ["vue-dep"] }),
				],
			}),
			"react-dep": item({ source: "r/react-dep.json" }),
			"vue-dep": item({ source: "r/vue-dep.json" }),
		};
		expect(
			collectRegistryDependencies(["button"], items, { framework: "vue" }).map(
				(e) => e.itemId,
			),
		).toEqual(["button", "vue-dep"]);
	});

	test("it should resolve dependsOn through pack pins and ignore duplicate references because tokens may pin dependencies", () => {
		const items = {
			button: item({
				dependsOn: ["lib"],
				packs: [pack("react", { dependsOn: ["lib@bundled"] })],
			}),
			lib: item({ source: "r/lib.json", packs: [pack("bundled")] }),
		};
		expect(
			collectRegistryDependencies(["button"], items, {}).map((e) => e.itemId),
		).toEqual(["button", "lib"]);
		expect(
			collectRegistryDependencies(["button@react"], items, {}).map(
				(e) => e.itemId,
			),
		).toEqual(["button", "lib"]);
	});
});

describe("packageManagerDropsCandidateDependsOn edges", () => {
	test("it should ignore manager-dependent packs without dependsOn because dropped edges need a dep to drop", () => {
		const entries: IndexEntry[] = [
			entry("button", {
				packs: [pack("pnpm-only", { when: { packageManager: "pnpm" } })],
			}),
		];
		expect(
			packageManagerDropsCandidateDependsOn(
				entries,
				["button"],
				{},
				NpmPackageManager.NPM,
			),
		).toBe(false);
	});
});

describe("visitInstallNode revisit pinning", () => {
	test("it should accept a second pin matching the first selection because diamond graphs revisit items", () => {
		const items = {
			app: item({ source: "r/app.json", dependsOn: ["button"] }),
			gate: item({ source: "r/gate.json", dependsOn: ["button@react"] }),
			button: item({
				source: "r/button.json",
				packs: [
					pack("react", { when: { framework: "react" } }),
					pack("vue", { when: { framework: "vue" } }),
				],
			}),
		};
		expect(
			buildInstallPlan(["app", "gate"], items, { framework: "react" }).map(
				(node) => node.itemId,
			),
		).toEqual(["button", "app", "gate"]);
	});

	test("it should throw when a dependency cycle is entered mid-walk because partially visited stacks are cycles", () => {
		const items = {
			a: item({ source: "r/a.json", dependsOn: ["b"] }),
			b: item({ source: "r/b.json", dependsOn: ["b"] }),
		};
		expect(() => buildInstallPlan(["a"], items, {})).toThrowError(
			'Registry dependency cycle detected at "b".',
		);
	});
});

describe("collectItemLocalConditions edge arms", () => {
	test("it should skip items without local conditions and prompt non-select locals without option lists because text prompts need no values", () => {
		const entries: IndexEntry[] = [
			entry("plain", { source: "r/plain.json" }),
			entry("alpha", {
				conditions: {
					name: condition({
						label: "Name",
						kind: RegistryConditionKind.TEXT,
						values: undefined,
					}),
				},
			}),
		];
		expect(collectItemLocalConditions(entries, {})).toEqual([
			{
				key: "name",
				label: "Name",
				kind: RegistryConditionKind.TEXT,
				values: [],
			},
		]);
	});

	test("it should skip local conditions whose own when is unsatisfied because gated locals prompt only when reachable", () => {
		const entries: IndexEntry[] = [
			entry("alpha", {
				conditions: {
					tier: condition({ when: { stage: "prod" } }),
					name: condition({
						label: "Name",
						kind: RegistryConditionKind.TEXT,
						values: undefined,
					}),
				},
			}),
		];
		const local = collectItemLocalConditions(entries, {});
		expect(local.map((entry) => entry.key)).toEqual(["name"]);
		expect(
			collectItemLocalConditions(entries, { stage: "prod" }).map(
				(entry) => entry.key,
			),
		).toEqual(["name", "tier"]);
	});
});

describe("buildRequiredCondition optional fields", () => {
	test("it should carry description, handler, and default onto the required condition because the CLI renders them", () => {
		const rich = condition({
			description: "Pick a framework",
			handler: "r/infer.js",
			default: "react",
		});
		const entries: IndexEntry[] = [entry("alpha", { requires: ["framework"] })];
		expect(collectRequiredConditions(entries, { framework: rich }, {})).toEqual(
			[
				{
					key: "framework",
					label: "Framework",
					kind: RegistryConditionKind.SELECT,
					values: [
						{ value: "react", label: "React" },
						{ value: "vue", label: "Vue" },
					],
					description: "Pick a framework",
					handler: "r/infer.js",
					default: "react",
				},
			],
		);
	});
});

describe("assumeContextFromSelectedItems edge arms", () => {
	test("it should skip plain tokens, reject unknown items, and tolerate pins without when maps because seeding only applies to declared pins", () => {
		const items = {
			button: item({ source: "r/button.json", packs: [pack("react")] }),
		};
		expect(assumeContextFromSelectedItems(["button"], items, {})).toEqual({});
		expect(assumeContextFromSelectedItems(["button@react"], items, {})).toEqual(
			{},
		);
		expect(() =>
			assumeContextFromSelectedItems(["ghost@react"], items, {}),
		).toThrowError('Registry item not found: "ghost".');
	});
});

describe("seedPinnedPackWhen multiselect and pin conflicts", () => {
	test("it should merge multiselect values from two pins instead of conflicting because multiselect accumulates", () => {
		const conditions = {
			extras: condition({
				label: "Extras",
				kind: RegistryConditionKind.MULTISELECT,
				values: [
					{ value: "lint", label: "Lint" },
					{ value: "format", label: "Format" },
				],
			}),
		};
		const items = {
			button: item({
				packs: [
					pack("lint", { when: { extras: ["lint"] } }),
					pack("fmt", { when: { extras: ["format"] } }),
				],
			}),
		};
		expect(
			assumeContextFromSelectedItems(
				["button@lint", "button@fmt"],
				items,
				conditions,
			),
		).toEqual({
			extras: ["lint", "format"],
		});
	});

	test("it should tolerate a pinned pack seeding the same scalar value twice because equal pins do not conflict", () => {
		const conditions = { framework: condition() };
		const items = {
			button: item({
				packs: [pack("react", { when: { framework: "react" } })],
			}),
		};
		expect(
			assumeContextFromSelectedItems(
				["button@react", "button@react"],
				items,
				conditions,
			),
		).toEqual({
			framework: "react",
		});
	});
});

describe("collectRequiredConditions packageManager runtime key", () => {
	test("it should not consult the conditions table for the reserved key because core owns the runtime value", () => {
		const entries: IndexEntry[] = [
			entry("alpha", {
				requires: ["packageManager"],
			}),
		];
		expect(
			collectRequiredConditions(entries, {}, {}, NpmPackageManager.NPM, [
				"alpha",
			]),
		).toEqual([]);
	});
});

describe("plan branch sweep", () => {
	test("it should omit sources from a packed item that matched nothing but has install phases because scripts-only packed items stay installable", () => {
		const gated = item({
			packs: [pack("react", { when: { framework: "react" } })],
			beforeWrite: ["r/before.js"],
		});
		expect(
			buildInstallPlan(["button"], { button: gated }, { framework: "vue" }),
		).toEqual([{ itemId: "button", beforeWriteScripts: ["r/before.js"] }]);
	});

	test("it should ignore when values from context-ruled-out packs because ruled-out packs must not widen prompts", () => {
		const entries: IndexEntry[] = [
			entry("alpha", {
				packs: [
					pack("react", { when: { framework: "react", extras: "lint" } }),
					pack("vue", { when: { framework: "vue" } }),
				],
			}),
		];
		expect(
			collectRequiredConditions(
				entries,
				{ extras: condition({ label: "Extras" }) },
				{ framework: "vue" },
			),
		).toEqual([]);
	});

	test("it should tolerate relevant packs without when maps because unconditional packs register nothing", () => {
		const entries: IndexEntry[] = [
			entry("alpha", { source: "r/a.json", packs: [pack("base")] }),
		];
		expect(collectRequiredConditions(entries, {}, {})).toEqual([]);
	});

	test("it should visit shared dependency targets once in the candidate closure because diamonds must not duplicate entries", () => {
		const items = {
			app: item({ dependsOn: ["b", "c"] }),
			b: item({ dependsOn: ["d"] }),
			c: item({ dependsOn: ["d"] }),
			d: item({ source: "r/d.json" }),
		};
		expect(
			collectRegistryDependencies(["app"], items).map((e) => e.itemId),
		).toEqual(["app", "b", "d", "c"]);
	});

	test("it should reject a missing dependency in the candidate closure because walks cannot continue without documents", () => {
		expect(() => collectRegistryDependencies(["ghost"], {})).toThrowError(
			'Registry item not found: "ghost".',
		);
	});

	test("it should scan packs without when maps for declared scripts because unconditional packs still declare hooks", () => {
		const registry: Registry = {
			types: { component: { label: "Components" } },
			conditions: { framework: condition({ handler: "r/infer.js" }) },
			items: {
				button: item({
					requires: ["framework"],
					packs: [pack("base", { beforeWrite: ["r/pack-before.js"] })],
				}),
			},
		};
		expect(collectDeclaredScriptUris(registry, ["button"])).toEqual({
			infer: ["r/infer.js"],
			mutation: ["r/pack-before.js"],
		});
	});

	test("it should report no dropped dependsOn for packs already ruled out by context because dead packs cannot drop edges", () => {
		const entries: IndexEntry[] = [
			entry("alpha", {
				packs: [
					pack("react", { when: { framework: "react" }, dependsOn: ["lib"] }),
				],
			}),
		];
		expect(
			packageManagerDropsCandidateDependsOn(
				entries,
				["alpha"],
				{ framework: "vue" },
				NpmPackageManager.PNPM,
			),
		).toBe(false);
	});

	test("it should allow a plain-token revisit of a planned item because unpinned re-requests cannot conflict", () => {
		const items = {
			button: item({
				source: "r/button.json",
				packs: [pack("react", { when: { framework: "react" } })],
			}),
		};
		expect(
			buildInstallPlan(["button", "button"], items, { framework: "react" }),
		).toEqual([
			{
				itemId: "button",
				packIds: ["react"],
				sources: ["r/button.json", "r/react.json"],
			},
		]);
	});

	test("it should throw when a select condition declares no values because a select prompt without options cannot proceed", () => {
		const noValues = condition({ values: undefined }) as RegistryCondition;
		expect(() =>
			collectRequiredConditions(
				[entry("alpha", { requires: ["framework"] })],
				{ framework: noValues },
				{},
			),
		).toThrowError(
			'Condition "framework" has no selectable values for the current install set.',
		);
	});

	test("it should skip shared conditions whose own when is unsatisfied because gated conditions prompt only when reachable", () => {
		const gated = condition({ when: { stage: "prod" } });
		const entries: IndexEntry[] = [entry("alpha", { requires: ["framework"] })];
		expect(
			collectRequiredConditions(
				entries,
				{ framework: gated },
				{ stage: "dev" },
			),
		).toEqual([]);
		expect(
			collectRequiredConditions(
				entries,
				{ framework: gated },
				{ stage: "prod" },
			).map((entry) => entry.key),
		).toEqual(["framework"]);
	});

	test("it should skip the reserved packageManager key when seeding pinned pack conditions because core selects the manager", () => {
		const items = {
			button: item({
				packs: [
					pack("pnpm", {
						when: { packageManager: "pnpm", framework: "react" },
					}),
				],
			}),
		};
		expect(
			assumeContextFromSelectedItems(["button@pnpm"], items, {
				framework: condition(),
			}),
		).toEqual({ framework: "react" });
	});
});
