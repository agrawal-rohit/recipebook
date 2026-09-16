import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("chalk", () => ({
	default: {
		hex: () => (message: string) => `hex:${message}`,
		bgRed: (message: string) => `bgRed:${message}`,
	},
}));

import { dangerHighlight, dimText, primaryText } from "./labels";

describe("cli/labels", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("primaryText", () => {
		it("applies the brand hex color", () => {
			expect(primaryText("hello")).toBe("hex:hello");
		});
	});

	describe("dimText", () => {
		it("styles the message without altering its text", () => {
			const styled = dimText("hello");
			expect(styled).toContain("hello");
			expect(styled).not.toBe("hello");
		});
	});

	describe("dangerHighlight", () => {
		it("applies a red background", () => {
			expect(dangerHighlight("ERR")).toBe("bgRed:ERR");
		});
	});
});
