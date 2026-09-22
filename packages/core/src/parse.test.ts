import { describe, expect, test } from "vitest";
import {
	compiledItemSchema,
	registryConditionSchema,
	registryItemSchema,
} from "./index";
import { parseRegistryDocument, parseWithSchema } from "./parse";
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

describe("parseRegistryDocument condition rules", () => {
	test("it should require values for select conditions because a select without options cannot be prompted", () => {
		expect(() =>
			parseRegistryDocument(
				baseDocument({
					conditions: {
						framework: { label: "Framework", kind: "select" },
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

	test("it should reject duplicate condition values because repeated options confuse prompting", () => {
		expect(() =>
			parseWithSchema(
				registryConditionSchema,
				{
					label: "Framework",
					kind: "select",
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
					kind: "select",
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
					kind: "select",
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
					kind: "select",
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
					kind: "multiselect",
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
					kind: "select",
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
							kind: "select",
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
					kind: "text",
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
					kind: "boolean",
					values: [{ value: "x", label: "X" }],
				},
				'Registry condition "flag"',
			),
		).toThrowError('of kind "boolean" cannot declare values.');
	});
});

describe("parseRegistryDocument when-map rules", () => {
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
					kind: "select",
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
				name: { label: "Name", kind: "text" },
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
				flag: { label: "Flag", kind: "boolean" },
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
});

describe("parseRegistryDocument reserved keys", () => {
	test("it should reject a shared condition named packageManager because the runtime owns that key", () => {
		const document = baseDocument({
			conditions: { packageManager: { label: "Manager", kind: "text" } },
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

describe("parseRegistryDocument condition graph", () => {
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
						style: { label: "Style", kind: "text" },
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
					conditions: { style: { label: "Style", kind: "text" } },
				}),
				card: baseItem({
					conditions: { style: { label: "Style", kind: "text" } },
				}),
			},
		});
		expect(() => parseRegistryDocument(document)).toThrowError(
			'Item-level condition "style" is declared by both "button" and "card".',
		);
	});

	test("it should reject a local condition colliding with a shared condition because keys must have one definition", () => {
		const document = baseDocument({
			conditions: { style: { label: "Style", kind: "text" } },
			items: {
				button: baseItem({
					conditions: { style: { label: "Style", kind: "text" } },
				}),
			},
		});
		expect(() => parseRegistryDocument(document)).toThrowError(
			'condition "style" collides with a shared condition.',
		);
	});
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
					kind: "select",
					min: 0,
					values: [{ value: "a", label: "A" }],
				},
				'Registry condition "f"',
			),
		).toThrowError(/Registry condition "f" min: Too small/);
	});
});
