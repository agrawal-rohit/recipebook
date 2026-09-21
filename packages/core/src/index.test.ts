import { describe, expect, test } from "vitest";
import * as coreModule from "./index";

describe("core public surface", () => {
	test("it should export buildRegistry when core provides build utilities for third-party registry authors because authoring is a core feature", () => {
		expect(typeof coreModule.buildRegistry).toBe("function");
	});

	test("it should not export publishedRegistryUrl when the bundled default URL fallback is removed because sources must be explicit", () => {
		expect(coreModule).not.toHaveProperty("publishedRegistryUrl");
	});

	// Green-by-construction guard: internal to the build pipeline (never
	// re-exported from the index). Third parties get it via buildRegistry's
	// return value, not as a public symbol.
	test("it should not re-export collectRegistryArtifactUris from the index because it is internal to the build pipeline", () => {
		expect(coreModule).not.toHaveProperty("collectRegistryArtifactUris");
	});
});
