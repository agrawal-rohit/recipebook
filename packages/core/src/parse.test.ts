import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
	compiledItemSchema,
	RegistryConditionKind,
	registryConditionSchema,
	registryItemSchema,
	registryPackSchema,
} from "./index";
import {
	parseKeyedRecord,
	parseRegistryDocument,
	parseWithSchema,
} from "./parse";
import {
	type IndexItem,
	RESERVED_CATALOG_TYPE_KEY,
	type Registry,
} from "./schema";

/** Minimal valid index item satisfying every refinement. */
function baseItem(overrides: Partial<IndexItem> = {}): IndexItem {
	return {
		title: "Button",
		description: "A button component",
		type: "component",
		source: "r/button.json",
		...overrides,
	};
}

/** Registry with one type and one item; extend per test. */
function baseDocument(overrides: {
	items?: Record<string, unknown>;
	conditions?: unknown;
	scriptIntegrity?: unknown;
	itemIntegrity?: unknown;
}): Record<string, unknown> {
	return {
		types: { component: { label: "Components" } },
		items: { button: baseItem() },
		...overrides,
	};
}

describe("parseRegistryDocument happy path", () => {
	test("it should parse a minimal document and omit absent optional fields because optional registry fields must stay absent after normalization", () => {
		const registry = parseRegistryDocument(baseDocument({}));
		expect(registry.types).toEqual({ component: { label: "Components" } });
		expect(registry.items.button).toEqual(baseItem());
		expect(registry.conditions).toBeUndefined();
		expect(registry.scriptIntegrity).toBeUndefined();
		expect(registry.itemIntegrity).toBeUndefined();
	});

	test("it should accept integrity maps keyed by catalog URI because compiled artifacts are verified by URI", () => {
		const registry: Registry = parseRegistryDocument(
			baseDocument({
				scriptIntegrity: {
					"r/hook.js": "sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
				},
				itemIntegrity: {
					"r/button.json":
						"sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
				},
			}),
		);
		expect(registry.scriptIntegrity?.["r/hook.js"]).toMatch(/^sha256-/);
		expect(registry.itemIntegrity?.["r/button.json"]).toMatch(/^sha256-/);
	});
});

describe("parseRegistryDocument map-key safety", () => {
	test("it should reject a `__proto__` item key because prototype pollution must not pass through registry maps", () => {
		const document = baseDocument({});
		// Simulate JSON.parse input: `obj["__proto__"] = x` only mutates the prototype,
		// so an own key must be defined explicitly.
		Object.defineProperty(document.items, "__proto__", {
			value: baseItem(),
			enumerable: true,
			writable: true,
			configurable: true,
		});
		expect(() => parseRegistryDocument(document)).toThrowError(
			'Registry key "__proto__" is not allowed.',
		);
	});

	test("it should reject an empty item key because a keyless item cannot be selected", () => {
		const document = baseDocument({});
		(document.items as Record<string, unknown>)[""] = baseItem();
		expect(() => parseRegistryDocument(document)).toThrowError(
			/Registry\.items\..*Invalid key in record/,
		);
	});

	test("it should reject an item key containing a path separator because item ids become payload paths under r/", () => {
		const document = baseDocument({});
		(document.items as Record<string, unknown>)["../escape"] = baseItem();
		expect(() => parseRegistryDocument(document)).toThrowError(
			/must be a single path segment/,
		);
	});

	test("it should reject an unknown top-level key because typos in registry documents must fail loudly", () => {
		const document = baseDocument({});
		document.itemz = {};
		expect(() => parseRegistryDocument(document)).toThrowError(
			/Registry has an unknown key: itemz\./,
		);
	});
});

describe("parseRegistryDocument types", () => {
	test("it should require a types declaration because every item needs display metadata", () => {
		expect(() => parseRegistryDocument({ items: {} })).toThrowError(
			"Registry types must be declared.",
		);
		expect(() => parseRegistryDocument({ items: {}, types: {} })).toThrowError(
			"Registry types must declare at least one type.",
		);
	});

	test("it should reject an item whose type is not declared because untyped items cannot be rendered in the catalog", () => {
		const document = baseDocument({});
		(document.items as Record<string, unknown>).misc = baseItem({
			type: "unknown-type",
		});
		expect(() => parseRegistryDocument(document)).toThrowError(
			'Registry item "misc" has undeclared type "unknown-type".',
		);
	});

	test("it should reject the reserved `all` type because the CLI reserves it for the --type all filter", () => {
		const document = baseDocument({});
		(document.items as Record<string, unknown>).bad = baseItem({
			type: RESERVED_CATALOG_TYPE_KEY,
		});
		expect(() => parseRegistryDocument(document)).toThrowError(/is reserved/);
	});
});

describe("parseRegistryDocument duplicate detection", () => {
	test("it should reject duplicate pack ids on an index item because two packs with one id cannot be selected", () => {
		const document = baseDocument({
			items: {
				button: baseItem({
					packs: [
						{ id: "react", title: "React", source: "r/button/react.json" },
						{
							id: "react",
							title: "React again",
							source: "r/button/react2.json",
						},
					],
				}),
			},
		});
		expect(() => parseRegistryDocument(document)).toThrowError(
			'has duplicate pack id "react".',
		);
	});

	test("it should reject duplicate beforeWrite entries because the same hook running twice is almost always a mistake", () => {
		const document = baseDocument({
			items: {
				button: baseItem({
					beforeWrite: ["r/a.js", "r/a.js"],
					source: "r/button.json",
				}),
			},
		});
		expect(() => parseRegistryDocument(document)).toThrowError(
			"more than once in beforeWrite",
		);
	});

	test("it should reject duplicate file targets in a compiled item because later writes would silently overwrite earlier ones", () => {
		expect(() =>
			parseWithSchema(
				compiledItemSchema,
				{
					files: [
						{ target: "a.txt", content: "one" },
						{ target: "a.txt", content: "two" },
					],
				},
				"Compiled item",
			),
		).toThrowError('Compiled item declares duplicate file target "a.txt".');
	});
});

test("it should require values for select conditions because a select without options cannot be prompted", () => {
	expect(() =>
		parseRegistryDocument(
			baseDocument({
				conditions: {
					framework: {
						label: "Framework",
						kind: RegistryConditionKind.SELECT,
					},
				},
				items: {
					button: baseItem({ requires: ["framework"] }),
				},
			}),
		),
	).toThrowError(
		'Registry condition "framework" must declare at least one value.',
	);
});

test("it should reject an empty values array with the empty-values message because the Zod size check fires before the condition refinement", () => {
	expect(() =>
		parseWithSchema(
			registryConditionSchema,
			{
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				values: [],
			},
			'Registry condition "framework"',
		),
	).toThrowError(
		'Registry condition "framework" must declare at least one value.',
	);
});

test("it should reject an empty files array with the file-count message because payloads must carry at least one file", () => {
	expect(() =>
		parseWithSchema(
			registryItemSchema,
			{
				id: "button",
				title: "Button",
				description: "A button component",
				type: "component",
				files: [],
			},
			"Registry item",
		),
	).toThrowError("Registry item.files must declare at least one file.");
});

test("it should fall back to the raw Zod message for unmapped empty arrays because not every too-small array has bespoke phrasing", () => {
	expect(() =>
		parseWithSchema(
			registryPackSchema,
			{
				id: "lint",
				title: "Lint",
				when: { framework: [] },
			},
			"Registry pack",
		),
	).toThrowError(/when\.framework: Too small/);
});

test("it should reject duplicate condition values because repeated options confuse prompting", () => {
	expect(() =>
		parseWithSchema(
			registryConditionSchema,
			{
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				values: [
					{ value: "react", label: "React" },
					{ value: "react", label: "React again" },
				],
			},
			'Registry condition "framework"',
		),
	).toThrowError('has duplicate value "react".');
});

test("it should reject the reserved `None` value because the CLI appends it as the skip option", () => {
	expect(() =>
		parseWithSchema(
			registryConditionSchema,
			{
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				values: [{ value: "None", label: "Skip" }],
			},
			'Registry condition "framework"',
		),
	).toThrowError('value "None" is reserved.');
});

test("it should reject defaults that are not declared values because a default the user cannot choose is broken", () => {
	expect(() =>
		parseWithSchema(
			registryConditionSchema,
			{
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				values: [{ value: "react", label: "React" }],
				default: "vue",
			},
			'Registry condition "framework"',
		),
	).toThrowError('default "vue" is not a declared value.');
});

test("it should reject min on non-multiselect conditions because min only applies to multiselect prompting", () => {
	expect(() =>
		parseWithSchema(
			registryConditionSchema,
			{
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				min: 2,
				values: [{ value: "react", label: "React" }],
			},
			'Registry condition "framework"',
		),
	).toThrowError('can only declare min for kind "multiselect".');
});

test("it should reject bindings on multiselect values because multiselects capture many values and cannot bind one option", () => {
	expect(() =>
		parseWithSchema(
			registryConditionSchema,
			{
				label: "Extras",
				kind: RegistryConditionKind.MULTISELECT,
				values: [
					{
						value: "lint",
						label: "Lint",
						bindings: { lintCommand: "pnpm lint" },
					},
				],
			},
			'Registry condition "extras"',
		),
	).toThrowError('of kind "multiselect" cannot declare option bindings.');
});

test("it should reject option binding keys that reuse their own condition key because bindings would overwrite the captured condition", () => {
	const document = baseDocument({
		conditions: {
			framework: {
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				values: [
					{
						value: "react",
						label: "React",
						bindings: { framework: "react-bind" },
					},
				],
			},
		},
		items: { button: baseItem({ requires: ["framework"] }) },
	});
	// Shared conditions are caught by the cross-map guard…
	expect(() => parseRegistryDocument(document)).toThrowError(
		'Registry condition "framework" value "react" cannot declare bindings.framework (collides with a condition key).',
	);

	// …while item-local conditions are caught by the schema refinement.
	const localDocument = baseDocument({
		items: {
			button: baseItem({
				conditions: {
					framework: {
						label: "Framework",
						kind: RegistryConditionKind.SELECT,
						values: [
							{
								value: "react",
								label: "React",
								bindings: { framework: "react-bind" },
							},
						],
					},
				},
			}),
		},
	});
	expect(() => parseRegistryDocument(localDocument)).toThrowError(
		'Registry condition "framework" option bindings cannot reuse the condition key "framework".',
	);
});

test("it should reject text and boolean conditions that declare values because those kinds prompt without options", () => {
	expect(() =>
		parseWithSchema(
			registryConditionSchema,
			{
				label: "Name",
				kind: RegistryConditionKind.TEXT,
				values: [{ value: "x", label: "X" }],
			},
			'Registry condition "name"',
		),
	).toThrowError('of kind "text" cannot declare values.');
	expect(() =>
		parseWithSchema(
			registryConditionSchema,
			{
				label: "Flag",
				kind: RegistryConditionKind.BOOLEAN,
				values: [{ value: "x", label: "X" }],
			},
			'Registry condition "flag"',
		),
	).toThrowError('of kind "boolean" cannot declare values.');
});

test("it should reject a pack when key that is not declared because undeclared conditions cannot be captured", () => {
	const document = baseDocument({
		items: {
			button: baseItem({
				packs: [
					{
						id: "react",
						title: "React",
						source: "r/button/react.json",
						when: { framework: "react" },
					},
				],
			}),
		},
	});
	expect(() => parseRegistryDocument(document)).toThrowError(
		'Registry item "button" pack "react" references unknown when key "framework".',
	);
});

test("it should reject a when value not declared by its condition because matchers must reference real options", () => {
	const document = baseDocument({
		conditions: {
			framework: {
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				values: [{ value: "react", label: "React" }],
			},
		},
		items: {
			button: baseItem({
				packs: [
					{
						id: "react",
						title: "React",
						source: "r/button/react.json",
						when: { framework: "vue" },
					},
				],
			}),
		},
	});
	expect(() => parseRegistryDocument(document)).toThrowError(
		'uses undeclared when value "vue" for key "framework".',
	);
});

test("it should reject text conditions used in when because text answers cannot match a fixed set", () => {
	const document = baseDocument({
		conditions: {
			name: { label: "Name", kind: RegistryConditionKind.TEXT },
		},
		items: {
			button: baseItem({
				packs: [
					{
						id: "named",
						title: "Named",
						source: "r/button/named.json",
						when: { name: "x" },
					},
				],
			}),
		},
	});
	expect(() => parseRegistryDocument(document)).toThrowError(
		/text conditions cannot be used in when/,
	);
});

test("it should reject non-boolean when values for boolean conditions because boolean matchers are true or false", () => {
	const document = baseDocument({
		conditions: {
			flag: { label: "Flag", kind: RegistryConditionKind.BOOLEAN },
		},
		items: {
			button: baseItem({
				packs: [
					{
						id: "flagged",
						title: "Flagged",
						source: "r/button/flagged.json",
						when: { flag: "yes" },
					},
				],
			}),
		},
	});
	expect(() => parseRegistryDocument(document)).toThrowError(
		'uses invalid when value "yes" for boolean key "flag" (expected true or false).',
	);
});

test("it should reject unknown packageManager when values because only registered managers may gate packs", () => {
	const document = baseDocument({
		items: {
			button: baseItem({
				packs: [
					{
						id: "npm-only",
						title: "npm only",
						source: "r/button/npm.json",
						when: { packageManager: "npm10" },
					},
				],
			}),
		},
	});
	expect(() => parseRegistryDocument(document)).toThrowError(
		'uses undeclared when value "npm10" for key "packageManager".',
	);
});

test("it should rethrow unexpected when values for fixed-set conditions because non-string matchers signal a policy bug", () => {
	const document = baseDocument({
		conditions: {
			framework: {
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				values: [{ value: "react", label: "React" }],
			},
		},
		items: {
			button: baseItem({
				packs: [
					{
						id: "react",
						title: "React",
						source: "r/button/react.json",
						when: { framework: true },
					},
				],
			}),
		},
	});
	expect(() => parseRegistryDocument(document)).toThrowError(/unexpected:true/);
});

describe("parseRegistryDocument reserved keys", () => {
	test("it should reject a shared condition named packageManager because the runtime owns that key", () => {
		const document = baseDocument({
			conditions: {
				packageManager: { label: "Manager", kind: RegistryConditionKind.TEXT },
			},
			items: { button: baseItem() },
		});
		expect(() => parseRegistryDocument(document)).toThrowError(
			'cannot declare reserved condition "packageManager"',
		);
	});

	test("it should reject an item requiring the reserved packageManager key because the CLI captures it outside prompts", () => {
		const document = baseDocument({
			items: { button: baseItem({ requires: ["packageManager"] }) },
		});
		expect(() => parseRegistryDocument(document)).toThrowError(
			/cannot require reserved condition "packageManager"/,
		);
	});
});

test("it should reject a required condition that is not declared because prompts need a definition", () => {
	const document = baseDocument({
		items: { button: baseItem({ requires: ["framework"] }) },
	});
	expect(() => parseRegistryDocument(document)).toThrowError(
		'Registry item "button" requires unknown condition "framework".',
	);
});

test("it should reject a key listed in both requires and item-local conditions because one key cannot be both shared and local", () => {
	const document = baseDocument({
		items: {
			button: baseItem({
				requires: ["style"],
				conditions: {
					style: { label: "Style", kind: RegistryConditionKind.TEXT },
				},
			}),
		},
	});
	expect(() => parseRegistryDocument(document)).toThrowError(
		/lists "style" in both requires and local conditions./,
	);
});

test("it should reject a local condition key claimed by two items because ownership must be unambiguous", () => {
	const document = baseDocument({
		items: {
			button: baseItem({
				conditions: {
					style: { label: "Style", kind: RegistryConditionKind.TEXT },
				},
			}),
			card: baseItem({
				conditions: {
					style: { label: "Style", kind: RegistryConditionKind.TEXT },
				},
			}),
		},
	});
	expect(() => parseRegistryDocument(document)).toThrowError(
		'Item-level condition "style" is declared by both "button" and "card".',
	);
});

test("it should reject a local condition colliding with a shared condition because keys must have one definition", () => {
	const document = baseDocument({
		conditions: {
			style: { label: "Style", kind: RegistryConditionKind.TEXT },
		},
		items: {
			button: baseItem({
				conditions: {
					style: { label: "Style", kind: RegistryConditionKind.TEXT },
				},
			}),
		},
	});
	expect(() => parseRegistryDocument(document)).toThrowError(
		'condition "style" collides with a shared condition.',
	);
});

describe("parseRegistryDocument installable payloads", () => {
	test("it should reject an index item with no source, scripts, or packs because it would install nothing", () => {
		const document = baseDocument({
			items: { button: baseItem({ source: undefined }) },
		});
		expect(() => parseRegistryDocument(document)).toThrowError(
			/must declare source, an install script \(beforeWrite\/afterInstall\), or at least one pack\./,
		);
	});

	test("it should reject a raw item with no files, scripts, or packs because it would install nothing", () => {
		expect(() =>
			parseWithSchema(
				registryItemSchema,
				{
					id: "empty",
					title: "Empty",
					description: "Nothing",
					type: "component",
				},
				'Registry item "empty"',
			),
		).toThrowError(/must declare files, an install script/);
	});

	test("it should accept an item that only runs scripts because script-only items install side effects without files", () => {
		const item = parseWithSchema(
			registryItemSchema,
			{
				id: "hooks",
				title: "Hooks",
				description: "Runs setup",
				type: "component",
				beforeWrite: ["setup.js"],
			},
			'Registry item "hooks"',
		);
		expect(item.beforeWrite).toEqual(["setup.js"]);
		expect(item.files).toBeUndefined();
	});
});

describe("parseRegistryDocument path safety", () => {
	test("it should reject raw item file paths that escape the registry because payloads must stay under the project root at install time", () => {
		expect(() =>
			parseWithSchema(
				registryItemSchema,
				{
					id: "escape",
					title: "Escape",
					description: "Escapes",
					type: "component",
					files: [{ source: "../outside.txt", target: "ok.txt" }],
				},
				'Registry item "escape"',
			),
		).toThrowError(
			/must be a relative path \(no absolute paths, URLs, or "\.\."\)\./,
		);
	});

	test("it should reject index item script paths that are absolute or URLs because compiled scripts resolve under the registry", () => {
		expect(() =>
			parseWithSchema(
				// indexItemSchema is exercised through the document parser.
				registryItemSchema,
				{
					id: "abs",
					title: "Abs",
					description: "Absolute",
					type: "component",
					beforeWrite: ["/abs/path.js"],
				},
				'Registry item "abs"',
			),
		).toThrowError(
			/must be a relative path under the registry \(no absolute paths or URLs\)\./,
		);
	});

	test("it should reject scriptIntegrity digests without the sha256 form because malformed digests would fail closed later with a worse message", () => {
		const document = baseDocument({
			scriptIntegrity: { "r/hook.js": "not-a-digest" },
		});
		expect(() => parseRegistryDocument(document)).toThrowError(
			/must be a sha256 integrity digest\./,
		);
	});
});

describe("parseWithSchema error mapping", () => {
	test("it should phrase non-object input as must-be-an-object because registry authors see this on malformed JSON", () => {
		expect(() =>
			parseWithSchema(compiledItemSchema, "nope", "Compiled item"),
		).toThrowError("Compiled item must be an object.");
	});

	test("it should fall back to a labeled raw zod message for unmapped issues because nothing should be swallowed silently", () => {
		expect(() =>
			parseWithSchema(
				registryConditionSchema,
				{
					label: "F",
					kind: RegistryConditionKind.SELECT,
					min: 0,
					values: [{ value: "a", label: "A" }],
				},
				'Registry condition "f"',
			),
		).toThrowError(/Registry condition "f" min: Too small/);
	});
});

test("it should phrase multiple unknown keys with the plural message because several typos need listing", () => {
	const document = baseDocument({});
	document.itemz = {};
	document.typez = {};
	expect(() => parseRegistryDocument(document)).toThrowError(
		"Registry has unknown keys: itemz, typez.",
	);
});

test("it should phrase invalid pack ids with the path-segment message because pack ids become payload paths", () => {
	const document = baseDocument({
		items: {
			button: baseItem({
				packs: [{ id: "a/b", title: "Bad", source: "r/x.json" }],
			}),
		},
	});
	expect(() => parseRegistryDocument(document)).toThrowError(
		/Registry items\["button"\]\.packs\[0\]\.id must be a single path segment/,
	);
});

test("it should phrase empty when-string values as non-empty strings because blank matchers are typos", () => {
	expect(() =>
		parseWithSchema(
			registryPackSchema,
			{ id: "lint", title: "Lint", when: { framework: "" } },
			"Registry pack",
		),
	).toThrowError("Registry pack.when.framework must be a non-empty string.");
});

test("it should fall back to the raw message for root-level array issues because there is no path segment to phrase", () => {
	expect(() =>
		parseWithSchema(z.array(z.string()).min(1), [], "Checklist"),
	).toThrowError(/Checklist: Too small/);
});

test("it should rethrow non-Zod errors untouched because only validation failures are rephrased", () => {
	const throwing = z.unknown().transform(() => {
		throw new Error("boom");
	});
	expect(() => parseWithSchema(throwing, "x", "Whatever")).toThrowError("boom");
});

test("it should reject a types key named `all` because the CLI reserves it for filtering", () => {
	const document = baseDocument({});
	document.types = { all: { label: "All" } };
	expect(() => parseRegistryDocument(document)).toThrowError(
		'Registry type "all" is reserved.',
	);
});

test("it should reject boolean when values for select conditions with the raw assertion code because remapping must not swallow unknown failures", () => {
	const document = baseDocument({
		conditions: {
			framework: {
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				values: [{ value: "react", label: "React" }],
			},
		},
		items: {
			button: baseItem({
				packs: [
					{
						id: "react",
						title: "React",
						source: "r/button/react.json",
						when: { framework: true },
					},
				],
			}),
		},
	});
	expect(() => parseRegistryDocument(document)).toThrowError("unexpected:true");
});

test("it should accept an array packageManager when because packs can gate on a set of managers", () => {
	const document = baseDocument({
		items: {
			button: baseItem({
				packs: [
					{
						id: "flex",
						title: "Flex",
						source: "r/button/flex.json",
						when: { packageManager: ["npm", "pnpm"] },
					},
				],
			}),
		},
	});
	const registry = parseRegistryDocument(document);
	expect(registry.items.button.packs?.[0]?.when).toEqual({
		packageManager: ["npm", "pnpm"],
	});
});

test("it should reject a when key that is undeclared even when other conditions exist because matchers need definitions", () => {
	const document = baseDocument({
		conditions: {
			flag: { label: "Flag", kind: RegistryConditionKind.BOOLEAN },
		},
		items: {
			button: baseItem({
				packs: [
					{
						id: "x",
						title: "X",
						source: "r/x.json",
						when: { framework: "react" },
					},
				],
			}),
		},
	});
	expect(() => parseRegistryDocument(document)).toThrowError(
		'Registry item "button" pack "x" references unknown when key "framework".',
	);
});

test("it should keep parsed conditions on the returned registry because shared definitions must survive parsing", () => {
	const document = baseDocument({
		conditions: {
			framework: {
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				values: [{ value: "react", label: "React" }],
			},
		},
		items: { button: baseItem({ requires: ["framework"] }) },
	});
	expect(parseRegistryDocument(document).conditions?.framework?.label).toBe(
		"Framework",
	);
});

describe("parseKeyedRecord null handling", () => {
	test("it should treat null keyed records like absent ones because JSON can produce nulls", () => {
		expect(
			parseKeyedRecord(
				registryConditionSchema,
				null,
				"Registry conditions",
				(key) => `Registry condition "${key}"`,
			),
		).toBeUndefined();
	});

	test("it should throw the absent message for null keyed records when required because null is not a usable map", () => {
		expect(() =>
			parseKeyedRecord(
				registryConditionSchema,
				null,
				"Registry conditions",
				(key) => `Registry condition "${key}"`,
				{ absent: "no conditions", empty: "no conditions" },
			),
		).toThrowError("no conditions");
	});
});

describe("parseWithSchema custom issue fallback", () => {
	test("it should fall back to the labeled raw message for unmapped custom issues because nothing should be swallowed silently", () => {
		const schema = z.string().superRefine((_value, context) => {
			context.addIssue({ code: "custom", message: "totally_unmapped" });
		});
		expect(() => parseWithSchema(schema, "x", "Widget")).toThrowError(
			"Widget: totally_unmapped",
		);
	});

	test("it should return the original error when a ZodError carries no issues because there is nothing to phrase", () => {
		const schema = z.unknown().transform(() => {
			throw new z.ZodError([]);
		});
		let thrown: unknown;
		try {
			parseWithSchema(schema, "x", "Widget");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(z.ZodError);
		expect((thrown as z.ZodError).issues).toEqual([]);
	});
});

describe("parseKeyedRecord raw-key safety", () => {
	test("it should reject a `__proto__` key on raw keyed records because prototype pollution must not pass through generic maps", () => {
		const raw: Record<string, unknown> = {};
		Object.defineProperty(raw, "__proto__", {
			value: { label: "X", kind: RegistryConditionKind.TEXT },
			enumerable: true,
			writable: true,
			configurable: true,
		});
		expect(() =>
			parseKeyedRecord(
				registryConditionSchema,
				raw,
				"Registry conditions",
				(key) => `Registry condition "${key}"`,
			),
		).toThrowError('Registry conditions key "__proto__" is not allowed.');
	});

	test("it should reject an empty raw key because a keyless entry cannot be selected", () => {
		expect(() =>
			parseKeyedRecord(
				registryConditionSchema,
				{ "": { label: "X", kind: RegistryConditionKind.TEXT } },
				"Registry conditions",
				(key) => `Registry condition "${key}"`,
			),
		).toThrowError("Registry conditions key must be a non-empty string.");
	});

	test("it should return undefined for an empty record without required messages because an optional empty map stays absent", () => {
		expect(
			parseKeyedRecord(
				registryConditionSchema,
				{},
				"Registry conditions",
				(key) => `Registry condition "${key}"`,
			),
		).toBeUndefined();
	});
});

test("it should accept a scalar beforeWrite string because one-script items need not wrap arrays", () => {
	const item = parseWithSchema(
		registryItemSchema,
		{
			id: "hooks",
			title: "Hooks",
			description: "Runs setup",
			type: "component",
			beforeWrite: "setup.js",
		},
		'Registry item "hooks"',
	);
	expect(item.beforeWrite).toEqual(["setup.js"]);
});

test("it should reject blank descriptions because empty strings are not descriptions", () => {
	expect(() =>
		parseWithSchema(
			registryItemSchema,
			{
				id: "quiet",
				title: "Quiet",
				description: "",
				type: "component",
				files: [{ source: "f.txt", target: "f.txt" }],
			},
			'Registry item "quiet"',
		),
	).toThrowError(
		'Registry item "quiet".description must be a non-empty string.',
	);
});

test("it should keep an ecosystem dependency map with runtime or dev entries and drop empty ones because empty maps are noise", () => {
	const base = {
		id: "button",
		title: "Button",
		description: "A button component",
		type: "component",
		files: [{ source: "f.txt", target: "f.txt" }],
	};
	const withRuntime = parseWithSchema(
		registryItemSchema,
		{ ...base, dependencies: { npm: { runtime: ["left-pad"] } } },
		'Registry item "button"',
	);
	expect(withRuntime.dependencies).toEqual({
		npm: { runtime: ["left-pad"] },
	});
	expect(
		parseWithSchema(
			registryItemSchema,
			{ ...base, dependencies: { npm: { dev: ["left-pad"] } } },
			'Registry item "button"',
		).dependencies,
	).toEqual({ npm: { dev: ["left-pad"] } });
	expect(
		parseWithSchema(
			registryItemSchema,
			{ ...base, dependencies: {} },
			'Registry item "button"',
		).dependencies,
	).toBeUndefined();
	expect(
		parseWithSchema(
			registryItemSchema,
			{ ...base, dependencies: { npm: {} } },
			'Registry item "button"',
		).dependencies,
	).toBeUndefined();
});

test("it should keep required flags and drop non-true ones because required is a boolean tri-state", () => {
	const required = parseWithSchema(
		registryConditionSchema,
		{ label: "Name", kind: RegistryConditionKind.TEXT, required: true },
		'Registry condition "name"',
	);
	expect(required.required).toBe(true);
	const optional = parseWithSchema(
		registryConditionSchema,
		{ label: "Name", kind: RegistryConditionKind.TEXT, required: false },
		'Registry condition "name"',
	);
	expect(optional.required).toBeUndefined();
});

test("it should allow option binding keys that do not collide with condition keys because only collisions are ambiguous", () => {
	const document = baseDocument({
		conditions: {
			framework: {
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				values: [
					{
						value: "react",
						label: "React",
						bindings: { lintCommand: "pnpm lint" },
					},
				],
			},
		},
		items: { button: baseItem({ requires: ["framework"] }) },
	});
	const registry = parseRegistryDocument(document);
	expect(registry.conditions?.framework?.values?.[0]?.bindings).toEqual({
		lintCommand: "pnpm lint",
	});
});

test("it should reject non-object condition maps because condition definitions must be keyed records", () => {
	const document = baseDocument({});
	document.conditions = [];
	expect(() => parseRegistryDocument(document)).toThrowError(
		"Registry.conditions must be an object.",
	);
	const nullDocument = baseDocument({});
	nullDocument.conditions = null;
	expect(() => parseRegistryDocument(nullDocument)).toThrowError(
		"Registry.conditions must be an object.",
	);
});

describe("item-local option bindings", () => {
	test("it should allow item-local option bindings that do not collide with sibling conditions because only collisions are ambiguous", () => {
		const document = baseDocument({
			items: {
				button: baseItem({
					conditions: {
						framework: {
							label: "Framework",
							kind: RegistryConditionKind.SELECT,
							values: [
								{
									value: "react",
									label: "React",
									bindings: { lintCommand: "pnpm lint" },
								},
							],
						},
					},
				}),
			},
		});
		const registry = parseRegistryDocument(document);
		expect(
			registry.items.button.conditions?.framework?.values?.[0]?.bindings,
		).toEqual({ lintCommand: "pnpm lint" });
	});
});

describe("condition value binding shapes", () => {
	test("it should reject empty option bindings because a bindings map with no keys is a declaration mistake", () => {
		expect(() =>
			parseWithSchema(
				registryConditionSchema,
				{
					label: "Framework",
					kind: RegistryConditionKind.SELECT,
					values: [
						{
							value: "react",
							label: "React",
							bindings: {},
						},
					],
				},
				'Registry condition "framework"',
			),
		).toThrowError(
			'Registry condition "framework" values[0].bindings must declare at least one binding.',
		);
	});
});
