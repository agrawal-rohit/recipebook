import { describe, expect, test } from "vitest";
import { registryItemTypeSchema } from "./index";

describe("registryItemTypeSchema description", () => {
	test("it should drop a blank optional description because empty strings normalize to undefined", () => {
		const parsed = registryItemTypeSchema.parse({
			label: "Component",
			description: "",
		});
		expect(Object.hasOwn(parsed, "description")).toBe(false);
		expect(parsed.description).toBeUndefined();
	});

	test("it should keep a non-empty optional description because populated docs are preserved", () => {
		const parsed = registryItemTypeSchema.parse({
			label: "Component",
			description: "A reusable component",
		});
		expect(parsed).toEqual({
			label: "Component",
			description: "A reusable component",
		});
	});
});
