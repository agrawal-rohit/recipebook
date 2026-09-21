import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as registryModule from "./registry";
import { locateRegistry } from "./registry";

// Keep an ambient `CHEETOS_REGISTRY` from leaking into tests that expect the
// saved-config path to be consulted.
beforeEach(() => {
	delete process.env.CHEETOS_REGISTRY;
});

describe("locateRegistry source precedence", () => {
	test("it should prefer an explicit --registry flag over CHEETOS_REGISTRY and the saved config when both are set because the explicit flag is the highest-precedence source", async () => {
		vi.stubEnv("CHEETOS_REGISTRY", "https://env.example.com/registry.json");
		try {
			await expect(
				locateRegistry({
					registry: "https://flag.example.com/registry.json",
					savedRegistry: "https://saved.example.com/registry.json",
				}),
			).resolves.toBe("https://flag.example.com/registry.json");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("it should prefer CHEETOS_REGISTRY over the saved config when both are set because an environment override must win over saved state", async () => {
		vi.stubEnv("CHEETOS_REGISTRY", "https://env.example.com/registry.json");
		try {
			await expect(
				locateRegistry({
					savedRegistry: "https://saved.example.com/registry.json",
				}),
			).resolves.toBe("https://env.example.com/registry.json");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("it should use the saved config when no flag or env override exists because the saved registry is what the user configured", async () => {
		expect(process.env.CHEETOS_REGISTRY).toBeUndefined();
		await expect(
			locateRegistry({
				savedRegistry: "https://saved.example.com/registry.json",
			}),
		).resolves.toBe("https://saved.example.com/registry.json");
	});

	test("it should reject an explicit HTTP URL even as a direct flag because remote registries must use HTTPS to avoid downgrade attacks", async () => {
		await expect(
			locateRegistry({ registry: "http://example.com/registry.json" }),
		).rejects.toThrow("Remote registries must use HTTPS.");
	});

	test("it should reject an explicit URL with credentials because embedding credentials leaks secrets and could redirect to an imposter", async () => {
		await expect(
			locateRegistry({
				registry: "https://user:pass@example.com/registry.json",
			}),
		).rejects.toThrow("Remote registries must not include credentials.");
	});

	test("it should resolve a relative flag source against the working directory without requiring the file to exist because relative sources are resolved at use time", async () => {
		await expect(
			locateRegistry({ registry: "some/missing-registry.json" }),
		).resolves.toBe(path.resolve(process.cwd(), "some/missing-registry.json"));
	});
});

describe("locateRegistry explicit-only resolution", () => {
	let probeRoot: string;

	beforeEach(() => {
		probeRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "cheetos-locate-explicit-"),
		);
		// Workers cannot `process.chdir()` (Stryker's vitest pool is threads), so
		// stub the single cwd seam that `locateRegistry` reads instead.
		vi.spyOn(process, "cwd").mockReturnValue(probeRoot);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(probeRoot, { recursive: true, force: true });
	});

	test("it should throw a NoRegistrySourceError naming `cheetos configure set` when no flag, env, or saved source is configured because the remediation must tell the user exactly how to add a source", async () => {
		const error: unknown = await locateRegistry().then(
			() => null,
			(e) => e,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("NoRegistrySourceError");
		expect((error as Error).message).toContain("cheetos configure set");
	});

	test("it should not discover a registry.json in the working directory when no explicit source is configured because implicit discovery contradicts explicit-only sources", async () => {
		fs.writeFileSync(path.join(probeRoot, "registry.json"), "{}");

		const error: unknown = await locateRegistry().then(
			() => null,
			(e) => e,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("NoRegistrySourceError");
	});

	test("it should throw NoRegistrySourceError instead of falling through to the saved config when CHEETOS_REGISTRY is empty because an empty env var must not silently fall back to saved state", async () => {
		vi.stubEnv("CHEETOS_REGISTRY", "");
		try {
			const error: unknown = await locateRegistry({
				savedRegistry: "https://saved.example.com/registry.json",
			}).then(
				() => null,
				(e) => e,
			);

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).name).toBe("NoRegistrySourceError");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

test("it should not export `bundledRegistryPath` from the module when the packaged default registry is removed because there is no bundled registry to locate", () => {
	expect(registryModule).not.toHaveProperty("bundledRegistryPath");
});
