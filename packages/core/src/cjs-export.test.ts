import { describe, expect, test } from "vitest";
import { unwrapModuleExport } from "./cjs-export";

describe("unwrapModuleExport", () => {
	test("it should return the default export when the module carries one because CJS transpiles `export default` into `{ default: fn }`", () => {
		const fn = () => 42;
		expect(unwrapModuleExport({ default: fn })).toBe(fn);
	});

	test("it should return the module object unchanged when there is no default key because `module.exports = fn` needs no unwrapping", () => {
		const fn = () => 42;
		expect(unwrapModuleExport(fn)).toBe(fn);
		expect(unwrapModuleExport({ infer: fn })).toEqual({ infer: fn });
	});

	test("it should return the module object when the default export is undefined because a missing default is not a usable export", () => {
		const moduleObject = { default: undefined, infer: () => 42 };
		expect(unwrapModuleExport(moduleObject)).toBe(moduleObject);
	});

	test("it should pass null through unchanged because only objects can carry a default export", () => {
		expect(unwrapModuleExport(null)).toBe(null);
	});

	test("it should pass primitives through unchanged because only objects can carry a default export", () => {
		expect(unwrapModuleExport(42)).toBe(42);
		expect(unwrapModuleExport("script")).toBe("script");
	});
});
