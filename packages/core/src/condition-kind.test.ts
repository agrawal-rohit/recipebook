import { describe, expect, test } from "vitest";
import {
	conditionKindPolicy,
	policyForConditionKind,
	RegistryConditionKind,
	type RegistryContext,
	type RegistryWhenValue,
} from "./condition-kind";
import { reservedInterpolationKeys } from "./index";

/** Negative-path fixtures: runtime-invalid values that must be rejected. */
function invalidWhenValue(value: unknown): RegistryWhenValue {
	return value as RegistryWhenValue;
}

import {
	assertConditionMapBindingKeys,
	registryConditionSchema,
	registryConditionValueSchema,
	registryPackSchema,
} from "./schema";

describe("conditionKindPolicy seedContext", () => {
	test("it should seed a multiselect context entry from a string when value because a pinned single value is a one-element selection", () => {
		const context: RegistryContext = {};
		conditionKindPolicy[RegistryConditionKind.MULTISELECT].seedContext(
			context,
			"k",
			"a",
		);
		expect(context).toEqual({ k: ["a"] });
	});

	test("it should filter non-string entries from a multiselect array because stored selections are strings only", () => {
		const context: RegistryContext = {};
		conditionKindPolicy[RegistryConditionKind.MULTISELECT].seedContext(
			context,
			"k",
			invalidWhenValue(["a", 2, "b"]),
		);
		expect(context).toEqual({ k: ["a", "b"] });
	});

	test("it should leave the key untouched when a multiselect seed is neither array nor string because only string selections can seed", () => {
		const context: RegistryContext = {};
		conditionKindPolicy[RegistryConditionKind.MULTISELECT].seedContext(
			context,
			"k",
			invalidWhenValue(42),
		);
		expect(context).toEqual({});
	});

	test("it should leave the key untouched when a multiselect array seed filters to nothing because an all-non-string matcher selects nothing", () => {
		const context: RegistryContext = {};
		conditionKindPolicy[RegistryConditionKind.MULTISELECT].seedContext(
			context,
			"k",
			invalidWhenValue([1, 2]),
		);
		expect(context).toEqual({});
	});

	test("it should leave the key untouched when a multiselect seed is empty because an empty matcher selects nothing", () => {
		const empty: RegistryContext = {};
		conditionKindPolicy[RegistryConditionKind.MULTISELECT].seedContext(
			empty,
			"k",
			[],
		);
		const nonStrings: RegistryContext = {};
		conditionKindPolicy[RegistryConditionKind.MULTISELECT].seedContext(
			nonStrings,
			"k",
			invalidWhenValue([1]),
		);
		expect(empty).toEqual({});
		expect(nonStrings).toEqual({});
	});

	test("it should overwrite a non-array existing multiselect value because a selection list replaces scalars", () => {
		const context: RegistryContext = { k: "old" };
		conditionKindPolicy[RegistryConditionKind.MULTISELECT].seedContext(
			context,
			"k",
			["b"],
		);
		expect(context).toEqual({ k: ["b"] });
	});

	test("it should union seeded values into an existing multiselect array without duplicates because seeds must accumulate", () => {
		const context: RegistryContext = { k: ["a"] };
		conditionKindPolicy[RegistryConditionKind.MULTISELECT].seedContext(
			context,
			"k",
			["b"],
		);
		expect(context).toEqual({ k: ["a", "b"] });

		// Re-seeding an already-present value must not duplicate it.
		conditionKindPolicy[RegistryConditionKind.MULTISELECT].seedContext(
			context,
			"k",
			["a"],
		);
		expect(context).toEqual({ k: ["a", "b"] });
	});

	test("it should seed a select context entry only from strings because select values are scalars", () => {
		const context: RegistryContext = {};
		const select = conditionKindPolicy[RegistryConditionKind.SELECT];
		select.seedContext(context, "k", "a");
		select.seedContext(context, "arr", ["a"]);
		select.seedContext(context, "bool", true);
		expect(context).toEqual({ k: "a" });
	});

	test("it should seed a boolean context entry only from booleans because string booleans are a different kind", () => {
		const context: RegistryContext = {};
		const boolean = conditionKindPolicy[RegistryConditionKind.BOOLEAN];
		boolean.seedContext(context, "yes", true);
		boolean.seedContext(context, "no", false);
		boolean.seedContext(context, "str", "true");
		expect(context).toEqual({ yes: true, no: false });
	});

	test("it should seed a text context entry only from strings because text values are strings", () => {
		const context: RegistryContext = {};
		conditionKindPolicy[RegistryConditionKind.TEXT].seedContext(
			context,
			"k",
			"v",
		);
		conditionKindPolicy[RegistryConditionKind.TEXT].seedContext(
			context,
			"n",
			invalidWhenValue(42),
		);
		expect(context).toEqual({ k: "v" });
	});
});

describe("conditionKindPolicy inferredContextValue", () => {
	const values = [
		{ value: "a", label: "A" },
		{ value: "b", label: "B" },
	];

	test("it should accept a declared multiselect array because every entry must be offered", () => {
		expect(
			conditionKindPolicy[
				RegistryConditionKind.MULTISELECT
			].inferredContextValue(["a", "b"], values),
		).toEqual(["a", "b"]);
	});

	test("it should wrap a declared multiselect string because a scalar infer is a one-element selection", () => {
		expect(
			conditionKindPolicy[
				RegistryConditionKind.MULTISELECT
			].inferredContextValue("a", values),
		).toEqual(["a"]);
	});

	test("it should reject a multiselect infer with an undeclared entry because handlers cannot invent values", () => {
		expect(
			conditionKindPolicy[
				RegistryConditionKind.MULTISELECT
			].inferredContextValue(["a", "zz"], values),
		).toBeUndefined();
	});

	test("it should reject non-string non-array multiselect infers because they cannot be selections", () => {
		const policy = conditionKindPolicy[RegistryConditionKind.MULTISELECT];
		expect(policy.inferredContextValue(true as never, values)).toBeUndefined();
		expect(policy.inferredContextValue(42 as never, values)).toBeUndefined();
	});

	test("it should return an empty array for an empty multiselect infer because every() is vacuously true", () => {
		expect(
			conditionKindPolicy[
				RegistryConditionKind.MULTISELECT
			].inferredContextValue([], values),
		).toEqual([]);
	});

	test("it should map boolean infers through truthy and falsy strings because handlers may return strings", () => {
		const policy = conditionKindPolicy[RegistryConditionKind.BOOLEAN];
		expect(policy.inferredContextValue(true, [])).toBe(true);
		expect(policy.inferredContextValue("true", [])).toBe(true);
		expect(policy.inferredContextValue("false", [])).toBe(false);
		expect(policy.inferredContextValue("yes", [])).toBeUndefined();
		expect(policy.inferredContextValue(1 as never, [])).toBeUndefined();
	});

	test("it should accept only declared select infers because select values are fixed", () => {
		const policy = conditionKindPolicy[RegistryConditionKind.SELECT];
		expect(policy.inferredContextValue("a", values)).toBe("a");
		expect(policy.inferredContextValue("zz", values)).toBeUndefined();
		expect(policy.inferredContextValue(["a"] as never, values)).toBeUndefined();
		expect(policy.inferredContextValue(true as never, values)).toBeUndefined();
		expect(policy.inferredContextValue(42 as never, values)).toBeUndefined();
		expect(policy.inferredContextValue(42 as never, [])).toBeUndefined();
	});

	test("it should accept non-empty text infers and reject empty or non-string ones because empty text is no value", () => {
		const policy = conditionKindPolicy[RegistryConditionKind.TEXT];
		expect(policy.inferredContextValue("v", [])).toBe("v");
		expect(policy.inferredContextValue("", [])).toBeUndefined();
		expect(policy.inferredContextValue(42 as never, [])).toBeUndefined();
	});
});

describe("conditionKindPolicy assertWhenValue", () => {
	test("it should accept declared select and multiselect when values because matching values are valid", () => {
		const declared = [{ value: "a", label: "A" }];
		expect(() =>
			conditionKindPolicy[RegistryConditionKind.SELECT].assertWhenValue(
				"a",
				declared,
			),
		).not.toThrow();
		expect(() =>
			conditionKindPolicy[RegistryConditionKind.MULTISELECT].assertWhenValue(
				["a", "b"],
				[...declared, { value: "b", label: "B" }],
			),
		).not.toThrow();
	});

	test("it should reject undeclared when values because matchers must name declared options", () => {
		const declared = [{ value: "a", label: "A" }];
		expect(() =>
			conditionKindPolicy[RegistryConditionKind.SELECT].assertWhenValue(
				"zz",
				declared,
			),
		).toThrowError("undeclared:zz");
		expect(() =>
			conditionKindPolicy[RegistryConditionKind.MULTISELECT].assertWhenValue(
				["a", "zz"],
				declared,
			),
		).toThrowError("undeclared:zz");
	});

	test("it should reject non-string entries before the declared check because type errors come first", () => {
		const declared = [{ value: "a", label: "A" }];
		expect(() =>
			conditionKindPolicy[RegistryConditionKind.MULTISELECT].assertWhenValue(
				invalidWhenValue(["a", 2]),
				declared,
			),
		).toThrowError(/unexpected:/);
	});

	test("it should reject any string when no values are declared because the declared set is the only source of truth", () => {
		expect(() =>
			conditionKindPolicy[RegistryConditionKind.SELECT].assertWhenValue(
				"a",
				undefined,
			),
		).toThrowError("undeclared:a");
	});

	test("it should accept only booleans for boolean kinds because boolean matchers are scalars", () => {
		const policy = conditionKindPolicy[RegistryConditionKind.BOOLEAN];
		expect(() => policy.assertWhenValue(true, undefined)).not.toThrow();
		expect(() => policy.assertWhenValue("true", undefined)).toThrowError(
			"boolean:true",
		);
		expect(() =>
			policy.assertWhenValue(invalidWhenValue(0), undefined),
		).toThrowError("boolean:0");
	});

	test("it should reject every text when value because text conditions cannot be matched declaratively", () => {
		expect(() =>
			conditionKindPolicy[RegistryConditionKind.TEXT].assertWhenValue(
				"x",
				undefined,
			),
		).toThrowError("text_in_when");
		expect(() =>
			conditionKindPolicy[RegistryConditionKind.TEXT].assertWhenValue(
				true,
				undefined,
			),
		).toThrowError("text_in_when");
	});
});

describe("policyForConditionKind", () => {
	test("it should mark select and multiselect as value-requiring and when-allowed because they prompt with fixed options", () => {
		expect(
			conditionKindPolicy[RegistryConditionKind.SELECT].requiresValues,
		).toBe(true);
		expect(
			conditionKindPolicy[RegistryConditionKind.MULTISELECT].requiresValues,
		).toBe(true);
		expect(
			conditionKindPolicy[RegistryConditionKind.BOOLEAN].requiresValues,
		).toBe(false);
		expect(conditionKindPolicy[RegistryConditionKind.TEXT].requiresValues).toBe(
			false,
		);
		expect(conditionKindPolicy[RegistryConditionKind.TEXT].allowsInWhen).toBe(
			false,
		);
		expect(conditionKindPolicy[RegistryConditionKind.SELECT].allowsInWhen).toBe(
			true,
		);
		expect(
			conditionKindPolicy[RegistryConditionKind.MULTISELECT].allowsInWhen,
		).toBe(true);
		expect(
			conditionKindPolicy[RegistryConditionKind.BOOLEAN].allowsInWhen,
		).toBe(true);
	});

	test("it should default an omitted kind to select because select is the effective kind for omitted declarations", () => {
		const policy = policyForConditionKind(undefined);
		expect(policy.kind).toBe(RegistryConditionKind.SELECT);
		expect(policy.requiresValues).toBe(true);
		expect(policy.allowsInWhen).toBe(true);
	});

	test("it should return the requested kind with its policy fields because callers need both", () => {
		const policy = policyForConditionKind(RegistryConditionKind.MULTISELECT);
		expect(policy.kind).toBe(RegistryConditionKind.MULTISELECT);
		expect(policy.seedContext).toBe(
			conditionKindPolicy[RegistryConditionKind.MULTISELECT].seedContext,
		);
	});
});

describe("registryConditionSchema default-kind matching", () => {
	const values = [{ value: "a", label: "A" }];

	function issues(condition: Record<string, unknown>): string[] {
		const result = registryConditionSchema.safeParse({
			label: "L",
			...condition,
		});
		if (result.success) return [];
		return result.error.issues.map((issue) => String(issue.message));
	}

	test("it should accept a boolean default for boolean conditions because the types match", () => {
		expect(
			issues({ kind: RegistryConditionKind.BOOLEAN, default: true }),
		).toEqual([]);
	});

	test("it should reject a string default for a boolean condition because the value kind must match", () => {
		expect(
			issues({ kind: RegistryConditionKind.BOOLEAN, default: "yes" }),
		).toEqual(["invalid_default:boolean"]);
	});

	test("it should accept declared string and array defaults for multiselect conditions because both are valid selections", () => {
		expect(
			issues({
				kind: RegistryConditionKind.MULTISELECT,
				values,
				default: "a",
			}),
		).toEqual([]);
		expect(
			issues({
				kind: RegistryConditionKind.MULTISELECT,
				values,
				default: ["a"],
			}),
		).toEqual([]);
	});

	test("it should reject a boolean default for a multiselect condition because multiselects hold strings", () => {
		expect(
			issues({
				kind: RegistryConditionKind.MULTISELECT,
				values,
				default: true,
			}),
		).toEqual(["invalid_default:multiselect"]);
	});

	test("it should accept a declared string default for select conditions and reject boolean ones because selects hold one string", () => {
		expect(
			issues({ kind: RegistryConditionKind.SELECT, values, default: "a" }),
		).toEqual([]);
		expect(
			issues({ kind: RegistryConditionKind.SELECT, values, default: true }),
		).toEqual(["invalid_default:select"]);
	});

	test("it should reject undeclared select defaults because defaults must be offered options", () => {
		expect(
			issues({ kind: RegistryConditionKind.SELECT, values, default: "zz" }),
		).toEqual(["undeclared_default:zz"]);
	});

	test("it should accept a string default for text conditions and reject booleans because text holds strings", () => {
		expect(issues({ kind: RegistryConditionKind.TEXT, default: "a" })).toEqual(
			[],
		);
		expect(issues({ kind: RegistryConditionKind.TEXT, default: true })).toEqual(
			["invalid_default:text"],
		);
	});
});

describe("registryConditionValueSchema bindings", () => {
	test("it should reject an empty bindings record because an empty binding map is an authoring mistake, not a default", () => {
		const result = registryConditionValueSchema.safeParse({
			value: "react",
			label: "React",
			bindings: {},
		});
		expect(
			result.success ? [] : result.error.issues.map((i) => i.message),
		).toEqual(["empty_bindings"]);
		expect(
			registryConditionValueSchema.safeParse({
				value: "react",
				label: "React",
				bindings: { lintCommand: "pnpm lint" },
			}).success,
		).toBe(true);
	});
});

describe("registryPackSchema id guard", () => {
	test("it should reject prototype, dot, and separator-bearing pack ids because ids become payload path segments", () => {
		const invalidIds: Array<[string, string]> = [
			["__proto__", "unsafe_key:__proto__"],
			[".", "invalid_id:."],
			["..", "invalid_id:.."],
			["a/b", "invalid_id:a/b"],
			["a\\b", "invalid_id:a\\b"],
		];
		for (const [id, message] of invalidIds) {
			const result = registryPackSchema.safeParse({ id, title: "Pack" });
			expect(
				result.success ? [] : result.error.issues.map((i) => i.message),
			).toContain(message);
		}
		expect(
			registryPackSchema.safeParse({ id: "lint", title: "Lint" }).success,
		).toBe(true);
	});
});

describe("assertConditionMapBindingKeys reserved keys", () => {
	test("it should reject option bindings that reuse reserved interpolation keys because bindings must not shadow CLI-captured values", () => {
		expect(() =>
			assertConditionMapBindingKeys(
				[
					{
						framework: {
							label: "Framework",
							kind: RegistryConditionKind.SELECT,
							values: [
								{
									value: "react",
									label: "React",
									bindings: { packageManager: "pnpm" },
								},
							],
						},
					},
				],
				reservedInterpolationKeys(),
			),
		).toThrowError(
			'Registry condition "framework" value "react" cannot declare bindings.packageManager (reserved interpolation key).',
		);
	});
});
