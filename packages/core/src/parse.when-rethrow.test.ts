import { describe, expect, test, vi } from "vitest";
import { RegistryConditionKind } from "./condition-kind";
import { parseRegistryDocument } from "./parse";

/**
 * Force the SELECT policy's `assertWhenValue` to throw a caller-chosen value so
 * `remapWhenAssertionError` can be driven through its non-`Error` normalization
 * and passthrough arms. All production policies throw `Error`, so these paths
 * are only reachable through a mocked policy.
 */
const signal = vi.hoisted(() => ({ thrown: "unexpected:boom" as unknown }));

vi.mock("./condition-kind", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./condition-kind")>();
	return {
		...actual,
		policyForConditionKind: (kind: RegistryConditionKind) =>
			kind === RegistryConditionKind.SELECT
				? {
						...actual.policyForConditionKind(kind),
						assertWhenValue: () => {
							throw signal.thrown;
						},
					}
				: actual.policyForConditionKind(kind),
	};
});

function documentWithPackWhen(): Record<string, unknown> {
	return {
		types: { component: { label: "Components" } },
		conditions: {
			framework: {
				label: "Framework",
				kind: RegistryConditionKind.SELECT,
				values: [{ value: "react", label: "React" }],
			},
		},
		items: {
			button: {
				title: "Button",
				description: "A button",
				type: "component",
				source: "r/button.json",
				packs: [
					{
						id: "react",
						title: "React",
						source: "r/button/react.json",
						when: { framework: "react" },
					},
				],
			},
		},
	} as Record<string, unknown>;
}

describe("remapWhenAssertionError non-Error signals", () => {
	test("it should rethrow an unrecognized non-Error assertion signal unchanged because malformed policy errors must surface as-is", () => {
		signal.thrown = "unexpected:boom";
		let thrown: unknown;
		try {
			parseRegistryDocument(documentWithPackWhen());
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBe("unexpected:boom");
	});

	test("it should normalize a non-Error assertion signal through String so recognized policy codes still produce user-facing errors", () => {
		signal.thrown = { toString: () => "text_in_when" };
		expect(() => parseRegistryDocument(documentWithPackWhen())).toThrowError(
			/references text condition "framework" in when/,
		);
	});
});
