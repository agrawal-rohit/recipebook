import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InvalidJsonError, sha256Integrity } from "@yoinker/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as registryModule from "./registry";
import {
	loadCompiledItems,
	loadRuntimeRegistry,
	locateRegistry,
} from "./registry";

/** JSON_DOCUMENT_BYTE_LIMIT in the module under test. */
const CAP = 5_000_000;

/** Minimal registry document that passes `parseRegistryDocument`. */
const MINIMAL_REGISTRY_JSON = JSON.stringify({
	types: { component: { label: "Components" } },
	items: {},
});

/** Minimal compiled item that passes `compiledItemSchema`. */
const MINIMAL_ITEM_JSON = JSON.stringify({ files: [] });

// Keep an ambient `YOINKER_REGISTRY` from leaking into tests that expect the
// saved-config path to be consulted.
beforeEach(() => {
	delete process.env.YOINKER_REGISTRY;
});

describe("locateRegistry source precedence", () => {
	test("it should prefer an explicit --registry flag over YOINKER_REGISTRY and the saved config when both are set because the explicit flag is the highest-precedence source", async () => {
		vi.stubEnv("YOINKER_REGISTRY", "https://env.example.com/registry.json");
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

	test("it should prefer YOINKER_REGISTRY over the saved config when both are set because an environment override must win over saved state", async () => {
		vi.stubEnv("YOINKER_REGISTRY", "https://env.example.com/registry.json");
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
		expect(process.env.YOINKER_REGISTRY).toBeUndefined();
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
			path.join(os.tmpdir(), "yoinker-locate-explicit-"),
		);
		// Workers cannot `process.chdir()` (Stryker's vitest pool is threads), so
		// stub the single cwd seam that `locateRegistry` reads instead.
		vi.spyOn(process, "cwd").mockReturnValue(probeRoot);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(probeRoot, { recursive: true, force: true });
	});

	test("it should throw a NoRegistrySourceError naming `yoinker configure set` when no flag, env, or saved source is configured because the remediation must tell the user exactly how to add a source", async () => {
		const error: unknown = await locateRegistry().then(
			() => null,
			(e) => e,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("NoRegistrySourceError");
		expect((error as Error).message).toContain("yoinker configure set");
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

	test("it should throw NoRegistrySourceError instead of falling through to the saved config when YOINKER_REGISTRY is empty because an empty env var must not silently fall back to saved state", async () => {
		vi.stubEnv("YOINKER_REGISTRY", "");
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

describe("module exports", () => {
	test("it should not export `bundledRegistryPath` from the module when the packaged default registry is removed because there is no bundled registry to locate", () => {
		expect(registryModule).not.toHaveProperty("bundledRegistryPath");
	});
});

describe("loadRuntimeRegistry remote fetch", () => {
	const INDEX_URL = "https://registry.example/r/registry.json";

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("it should load and parse a remote registry over HTTPS with a GET, redirect-rejecting, timeout-guarded request because remote fetching is the default registry path", async () => {
		const fetchMock = vi.fn<
			(input: string | URL, init?: RequestInit) => Promise<Response>
		>(async () => new Response(MINIMAL_REGISTRY_JSON, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await loadRuntimeRegistry(INDEX_URL);

		expect(result.indexLocation).toBe(INDEX_URL);
		expect(result.registry.types.component?.label).toBe("Components");
		expect(fetchMock).toHaveBeenCalledWith(
			new URL(INDEX_URL),
			expect.objectContaining({
				method: "GET",
				redirect: "error",
				headers: { accept: "application/json" },
			}),
		);
		const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	test("it should reject a streamed body larger than the document cap because a registry must never be able to stream unbounded data", async () => {
		const chunks = 6;
		const chunkSize = 1_000_000;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let index = 0; index < chunks; index += 1)
					controller.enqueue(new Uint8Array(chunkSize));
				controller.close();
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(stream, { status: 200 })),
		);

		await expect(loadRuntimeRegistry(INDEX_URL)).rejects.toThrowError(
			"Remote registry is too large.",
		);
	});

	test("it should accept a body of exactly the cap because the limit is strict-greater, not greater-or-equal", async () => {
		const head = '{"types":{"component":{"label":"c","description":"';
		const tail = '"}},"items":{}}';
		const pad = "a".repeat(CAP - head.length - tail.length);
		expect(Buffer.byteLength(head + pad + tail, "utf8")).toBe(CAP);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(head + pad + tail, { status: 200 })),
		);

		const result = await loadRuntimeRegistry(INDEX_URL);
		expect(result.registry.types.component?.label).toBe("c");
	});

	test("it should reject a Content-Length claiming an over-cap body without consuming the body because the header decides before any download", async () => {
		// A stream that never settles: if the body were read, the test would hang
		// instead of observing the header-driven rejection.
		const neverStream = new ReadableStream<Uint8Array>({
			pull() {
				return new Promise<never>(() => {});
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(neverStream, {
						status: 200,
						headers: { "content-length": String(CAP + 1) },
					}),
			),
		);

		await expect(loadRuntimeRegistry(INDEX_URL)).rejects.toThrowError(
			"Remote registry is too large.",
		);
	});

	test("it should reject a non-integer Content-Length because a malformed length header cannot be trusted", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(MINIMAL_REGISTRY_JSON, {
						status: 200,
						headers: { "content-length": "12abc" },
					}),
			),
		);

		await expect(loadRuntimeRegistry(INDEX_URL)).rejects.toThrowError(
			"Remote registry has an invalid Content-Length.",
		);
	});

	test("it should accept a Content-Length matching the body size because a truthful length header must not be treated as an attack", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(MINIMAL_REGISTRY_JSON, {
						status: 200,
						headers: {
							"content-length": String(
								Buffer.byteLength(MINIMAL_REGISTRY_JSON, "utf8"),
							),
						},
					}),
			),
		);

		const result = await loadRuntimeRegistry(INDEX_URL);
		expect(result.registry.types.component?.label).toBe("Components");
	});

	test("it should accept a Content-Length of exactly the cap because the header limit is strict-greater, not greater-or-equal", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(MINIMAL_REGISTRY_JSON, {
						status: 200,
						headers: { "content-length": String(CAP) },
					}),
			),
		);

		const result = await loadRuntimeRegistry(INDEX_URL);
		expect(result.registry.types.component?.label).toBe("Components");
	});

	test("it should refuse a redirect because a public registry URL must not bounce to another host", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed: received a redirect response");
			}),
		);

		await expect(loadRuntimeRegistry(INDEX_URL)).rejects.toThrowError(
			"Remote registries must not redirect.",
		);
	});

	test("it should map an abort/timeout fetch failure to a labeled timeout error because a hung fetch must be diagnosable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const timeout = new Error("The operation was aborted due to timeout");
				timeout.name = "TimeoutError";
				throw timeout;
			}),
		);

		await expect(loadRuntimeRegistry(INDEX_URL)).rejects.toThrowError(
			`Timed out fetching registry from ${INDEX_URL} after 10s.`,
		);
	});

	test("it should map a network failure to a labeled error preserving the cause because connectivity problems must keep their original diagnostics", async () => {
		const networkError = new Error("connect ECONNREFUSED");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw networkError;
			}),
		);

		const error = await loadRuntimeRegistry(INDEX_URL).then(
			() => null,
			(e) => e,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			`Failed to fetch registry from ${INDEX_URL}.`,
		);
		expect((error as Error & { cause?: unknown }).cause).toBe(networkError);
	});

	test("it should map an HTTP error status to a labeled failure because a missing registry must not look like a network bug", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 404 })),
		);

		await expect(loadRuntimeRegistry(INDEX_URL)).rejects.toThrowError(
			/Failed to fetch registry \(404/u,
		);
	});

	test("it should ignore a falsy chunk while streaming a remote body because the stream protocol can deliver a hole that carries no bytes", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new Uint8Array(Buffer.from(MINIMAL_REGISTRY_JSON, "utf8")),
				);
				// Deliberate protocol violation: a hole in the stream.
				// @ts-expect-error exercise the defensive `!value` continue arm
				controller.enqueue(undefined);
				controller.close();
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(stream, { status: 200 })),
		);

		const result = await loadRuntimeRegistry(INDEX_URL);
		expect(result.registry.types.component?.label).toBe("Components");
	});

	test("it should reject a 200 response with no body because an empty document can never be a registry", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 200 })),
		);

		await expect(loadRuntimeRegistry(INDEX_URL)).rejects.toThrowError(
			"Remote registry returned an empty body.",
		);
	});

	test("it should reject remote invalid JSON with a labeled plain error, not InvalidJsonError, because the InvalidJsonError contract belongs to local documents", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{not json", { status: 200 })),
		);

		const error = await loadRuntimeRegistry(INDEX_URL).then(
			() => null,
			(e) => e,
		);
		expect(error).not.toBeInstanceOf(InvalidJsonError);
		expect((error as Error).message).toMatch(
			/Remote registry returned invalid JSON:/u,
		);
	});
});

describe("loadRuntimeRegistry local file", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoinker-registry-load-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("it should load and parse a local registry file because local registries are the offline default", async () => {
		const registryPath = path.join(tmpDir, "registry.json");
		fs.writeFileSync(registryPath, MINIMAL_REGISTRY_JSON, "utf8");

		const result = await loadRuntimeRegistry(registryPath);

		expect(result.indexLocation).toBe(registryPath);
		expect(result.registry.types.component?.label).toBe("Components");
	});

	test("it should wrap a missing local file with a labeled error preserving the cause because ENOENT alone does not say which document failed", async () => {
		const missingPath = path.join(tmpDir, "nope.json");

		const error = await loadRuntimeRegistry(missingPath).then(
			() => null,
			(e) => e,
		);

		expect((error as Error).message).toBe(
			`Failed to read registry at ${missingPath}: ENOENT: no such file or directory, open '${missingPath}'`,
		);
		expect(
			(error as Error & { cause?: NodeJS.ErrnoException }).cause?.code,
		).toBe("ENOENT");
	});

	test("it should wrap an unexpected local read failure with the labeled error and cause because only registry authors can act on filesystem permissions", async () => {
		const registryPath = path.join(tmpDir, "registry.json");
		fs.writeFileSync(registryPath, MINIMAL_REGISTRY_JSON, "utf8");
		const readFileSpy = vi
			.spyOn(await import("@yoinker/core"), "readFileAsync")
			.mockRejectedValueOnce(
				Object.assign(new Error("denied"), { code: "EACCES" }),
			);
		try {
			const error = await loadRuntimeRegistry(registryPath).then(
				() => null,
				(e) => e,
			);
			expect((error as Error).message).toBe(
				`Failed to read registry at ${registryPath}: denied`,
			);
			expect(
				(error as Error & { cause?: NodeJS.ErrnoException }).cause?.code,
			).toBe("EACCES");
		} finally {
			readFileSpy.mockRestore();
		}
	});

	test("it should throw InvalidJsonError for a local document with invalid JSON because local parse failures carry the file location", async () => {
		const registryPath = path.join(tmpDir, "registry.json");
		fs.writeFileSync(registryPath, "{oops", "utf8");

		const error = await loadRuntimeRegistry(registryPath).then(
			() => null,
			(e) => e,
		);

		expect(error).toBeInstanceOf(InvalidJsonError);
		expect((error as Error).name).toBe("InvalidJsonError");
		expect((error as Error).message).toContain(registryPath);
	});

	test("it should wrap a local non-SyntaxError parse failure with the labeled read error because only malformed documents deserve the InvalidJsonError contract", async () => {
		const registryPath = path.join(tmpDir, "registry.json");
		fs.writeFileSync(registryPath, "{oops", "utf8");
		const parseSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
			throw new TypeError("unexpected token");
		});
		try {
			const error = await loadRuntimeRegistry(registryPath).then(
				() => null,
				(e) => e,
			);

			expect(error).not.toBeInstanceOf(InvalidJsonError);
			expect((error as Error).message).toBe(
				`Failed to read registry at ${registryPath}: unexpected token`,
			);
			expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(
				TypeError,
			);
		} finally {
			parseSpy.mockRestore();
		}
	});

	test("it should wrap a remote non-SyntaxError parse failure with the labeled invalid-JSON error because remote documents never use the local error contract", async () => {
		const remoteUrl = "https://registry.example/r/registry.json";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{not json", { status: 200 })),
		);
		const parseSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
			throw new TypeError("boom");
		});
		try {
			const error = await loadRuntimeRegistry(remoteUrl).then(
				() => null,
				(e) => e,
			);

			expect(error).not.toBeInstanceOf(InvalidJsonError);
			expect((error as Error).message).toBe(
				"Remote registry returned invalid JSON: boom",
			);
		} finally {
			parseSpy.mockRestore();
		}
	});

	test("it should stringify a non-Error parse rejection because whatever JSON.parse throws must still reach the labeled error", async () => {
		const registryPath = path.join(tmpDir, "registry.json");
		fs.writeFileSync(registryPath, "{oops", "utf8");
		const parseSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
			throw "thrown string";
		});
		try {
			const error = await loadRuntimeRegistry(registryPath).then(
				() => null,
				(e) => e,
			);

			expect(error).not.toBeInstanceOf(InvalidJsonError);
			expect((error as Error).message).toBe(
				`Failed to read registry at ${registryPath}: thrown string`,
			);
		} finally {
			parseSpy.mockRestore();
		}
	});

	test("it should stringify a non-Error local read rejection because whatever the filesystem layer throws must still reach the labeled error", async () => {
		const registryPath = path.join(tmpDir, "registry.json");
		const readFileSpy = vi
			.spyOn(await import("@yoinker/core"), "readFileAsync")
			.mockRejectedValueOnce("plain string failure");
		try {
			const error = await loadRuntimeRegistry(registryPath).then(
				() => null,
				(e) => e,
			);

			expect((error as Error).message).toBe(
				`Failed to read registry at ${registryPath}: plain string failure`,
			);
			expect((error as Error & { cause?: unknown }).cause).toBe(
				"plain string failure",
			);
		} finally {
			readFileSpy.mockRestore();
		}
	});

	test("it should reject a local file larger than the cap because the size limit must not depend on the transport", async () => {
		const registryPath = path.join(tmpDir, "registry.json");
		fs.writeFileSync(registryPath, "a".repeat(CAP + 1), "utf8");

		await expect(loadRuntimeRegistry(registryPath)).rejects.toThrowError(
			`registry at ${registryPath} is too large.`,
		);
	});

	test("it should accept a local file of exactly the cap because the local limit is strict-greater, not greater-or-equal", async () => {
		const head = '{"types":{"component":{"label":"c","description":"';
		const tail = '"}},"items":{}}';
		const pad = "a".repeat(CAP - head.length - tail.length);
		expect(Buffer.byteLength(head + pad + tail, "utf8")).toBe(CAP);
		const registryPath = path.join(tmpDir, "registry.json");
		fs.writeFileSync(registryPath, head + pad + tail, "utf8");

		const result = await loadRuntimeRegistry(registryPath);
		expect(result.registry.types.component?.label).toBe("c");
	});
});

describe("loadCompiledItems", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoinker-registry-items-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.unstubAllGlobals();
	});

	test("it should load each unique source once relative to the index location because duplicate sources must not double-fetch", async () => {
		const indexLocation = path.join(tmpDir, "registry.json");
		fs.mkdirSync(path.join(tmpDir, "r"));
		fs.writeFileSync(
			path.join(tmpDir, "r", "a.json"),
			MINIMAL_ITEM_JSON,
			"utf8",
		);
		fs.writeFileSync(
			path.join(tmpDir, "r", "b.json"),
			MINIMAL_ITEM_JSON,
			"utf8",
		);

		const documents = await loadCompiledItems(
			indexLocation,
			["r/a.json", "r/a.json", "r/b.json"],
			{
				// itemIntegrity is mandatory: verification fails closed without digests.
				"r/a.json": sha256Integrity(MINIMAL_ITEM_JSON),
				"r/b.json": sha256Integrity(MINIMAL_ITEM_JSON),
			},
		);

		expect([...documents.keys()].sort()).toEqual(["r/a.json", "r/b.json"]);
		expect(documents.get("r/a.json")).toEqual({ files: [] });
		expect(fs.readFileSync(path.join(tmpDir, "r", "a.json"), "utf8")).toBe(
			MINIMAL_ITEM_JSON,
		);
	});

	test("it should join item sources against a remote index URL because remote registries resolve compiled items relative to the index document", async () => {
		const indexUrl = "https://registry.example/r/registry.json";
		const fetchMock = vi.fn<
			(input: string | URL, init?: RequestInit) => Promise<Response>
		>(async () => new Response(MINIMAL_ITEM_JSON, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const documents = await loadCompiledItems(
			indexUrl,
			["a.json", "a.json", "b.json"],
			{
				"a.json": sha256Integrity(MINIMAL_ITEM_JSON),
				"b.json": sha256Integrity(MINIMAL_ITEM_JSON),
			},
		);

		expect([...documents.keys()].sort()).toEqual(["a.json", "b.json"]);
		const calledUrls = fetchMock.mock.calls.map(
			(call) => (call[0] as URL).href,
		);
		expect(calledUrls.sort()).toEqual([
			"https://registry.example/r/a.json",
			"https://registry.example/r/b.json",
		]);
	});

	test("it should reject a compiled item whose bytes do not match the registry digest because tampered payloads must never load", async () => {
		const indexLocation = path.join(tmpDir, "registry.json");
		fs.mkdirSync(path.join(tmpDir, "r"));
		fs.writeFileSync(
			path.join(tmpDir, "r", "a.json"),
			MINIMAL_ITEM_JSON,
			"utf8",
		);

		await expect(
			loadCompiledItems(indexLocation, ["r/a.json"], {
				"r/a.json": sha256Integrity("wrong"),
			}),
		).rejects.toThrowError("Integrity check failed for item r/a.json");
	});

	test("it should reject a compiled item with a missing digest (map or entry) because verification must fail closed", async () => {
		const indexLocation = path.join(tmpDir, "registry.json");
		fs.mkdirSync(path.join(tmpDir, "r"));
		fs.writeFileSync(
			path.join(tmpDir, "r", "a.json"),
			MINIMAL_ITEM_JSON,
			"utf8",
		);

		await expect(
			loadCompiledItems(indexLocation, ["r/a.json"], {}),
		).rejects.toThrowError("Missing integrity digest for item r/a.json");
		await expect(
			loadCompiledItems(indexLocation, ["r/a.json"], {}),
		).rejects.toThrowError("Missing integrity digest for item r/a.json");
	});

	test("it should label schema violations with the compiled item source because a malformed payload must name its URI", async () => {
		const indexLocation = path.join(tmpDir, "registry.json");
		fs.mkdirSync(path.join(tmpDir, "r"));
		fs.writeFileSync(
			path.join(tmpDir, "r", "a.json"),
			JSON.stringify({ files: "not-a-list" }),
			"utf8",
		);

		await expect(
			loadCompiledItems(indexLocation, ["r/a.json"], {
				"r/a.json": sha256Integrity(JSON.stringify({ files: "not-a-list" })),
			}),
		).rejects.toThrowError(/Compiled item "r\/a\.json"/u);
	});

	test("it should reject the whole load when one source fails because a partial install plan is unusable", async () => {
		const indexUrl = "https://registry.example/r/registry.json";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: URL) => {
				if (input.href.endsWith("a.json")) throw new Error("network gone");
				return new Response(MINIMAL_ITEM_JSON, { status: 200 });
			}),
		);

		await expect(
			loadCompiledItems(indexUrl, ["a.json", "b.json"], {}),
		).rejects.toThrowError("Failed to fetch compiled item from ");
	});
});
