import path from "node:path";
import type { Registry } from "@pebbles/core";
import { InvalidJsonError, sha256Integrity } from "@pebbles/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIsFileAsync = vi.fn<(candidate: string) => Promise<boolean>>();
const mockReadFileAsync = vi.fn();
const mockParseRegistryDocument = vi.fn();
const mockFetch = vi.fn();

vi.mock("@pebbles/core", async () => {
	const actual =
		await vi.importActual<typeof import("@pebbles/core")>("@pebbles/core");
	return {
		...actual,
		isFileAsync: (candidate: string) => mockIsFileAsync(candidate),
		readFileAsync: (location: string) => mockReadFileAsync(location),
		parseRegistryDocument: (raw: unknown) => mockParseRegistryDocument(raw),
	};
});

import {
	loadCompiledItems,
	loadRuntimeRegistry,
	locateRegistry,
} from "./registry";

const sampleRegistry: Registry = {
	types: {},
	items: {},
};

const publicRegistryBody = JSON.stringify({
	types: {},
	items: {},
});

interface MockFetchOptions {
	status?: number;
	statusText?: string;
	headers?: Record<string, string>;
	body?: string | Buffer;
	/** Reject the fetch promise instead of returning a Response. */
	rejectWith?: Error;
}

/**
 * Arrange global fetch to return a Response (or reject).
 * @param response - Fake response fields.
 */
function mockFetchOk(response: MockFetchOptions = {}): void {
	mockFetch.mockImplementation(async () => {
		if (response.rejectWith) throw response.rejectWith;

		const body = response.body ?? publicRegistryBody;
		const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
		const headers = new Headers(
			response.headers ?? {
				"content-length": String(bytes.length),
			},
		);

		// Response BodyInit accepts Uint8Array; Node Buffer is not in the DOM typings.
		return new Response(new Uint8Array(bytes), {
			status: response.status ?? 200,
			statusText: response.statusText ?? "OK",
			headers,
		});
	});
}

describe("locateRegistry", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(process, "cwd").mockReturnValue("/workspace");
		Reflect.deleteProperty(process.env, "PEBBLES_REGISTRY");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("prefers an explicit URL registry override", async () => {
		await expect(
			locateRegistry({
				registry: "https://example.com/registry.json",
				bundledRegistryPath: "/bundle/registry.json",
			}),
		).resolves.toBe("https://example.com/registry.json");
		expect(mockIsFileAsync).not.toHaveBeenCalled();
	});

	it("rejects an explicit HTTP registry override", async () => {
		await expect(
			locateRegistry({
				registry: "http://example.com/registry.json",
				bundledRegistryPath: "/bundle/registry.json",
			}),
		).rejects.toThrow("Remote registries must use HTTPS.");
	});

	it("rejects an explicit localhost registry override", async () => {
		await expect(
			locateRegistry({
				registry: "https://localhost/registry.json",
				bundledRegistryPath: "/bundle/registry.json",
			}),
		).rejects.toThrow("Remote registries cannot target localhost.");
	});

	it("rejects an explicit registry override with credentials", async () => {
		await expect(
			locateRegistry({
				registry: "https://user:secret@example.com/registry.json",
				bundledRegistryPath: "/bundle/registry.json",
			}),
		).rejects.toThrow("Remote registries must not include credentials.");
	});

	it("joins an explicit file override relative to cwd", async () => {
		await expect(
			locateRegistry({
				registry: "./custom/registry.json",
				bundledRegistryPath: "/bundle/registry.json",
			}),
		).resolves.toBe(path.resolve("/workspace", "./custom/registry.json"));
	});

	it("loads the current working directory registry before bundled fallbacks", async () => {
		const cwdRegistry = path.resolve("/workspace", "registry.json");
		mockIsFileAsync.mockImplementation(async (candidate: string) => {
			return candidate === cwdRegistry;
		});

		await expect(
			locateRegistry({
				bundledRegistryPath: "/bundle/registry.json",
			}),
		).resolves.toBe(cwdRegistry);
	});

	it("falls back to the bundled registry.json when cwd has none", async () => {
		const packagedRegistry = "/bundle/registry.json";
		mockIsFileAsync.mockImplementation(async (candidate: string) => {
			return candidate === packagedRegistry;
		});

		await expect(
			locateRegistry({
				bundledRegistryPath: packagedRegistry,
			}),
		).resolves.toBe(packagedRegistry);
	});

	it("uses fallback registry probe paths before the bundled copy", async () => {
		const packagedRegistry = "/bundle/registry.json";
		const fallbackRegistry = "/workspace/packages/registry/registry.json";
		mockIsFileAsync.mockImplementation(async (candidate: string) => {
			return candidate === packagedRegistry || candidate === fallbackRegistry;
		});

		await expect(
			locateRegistry({
				bundledRegistryPath: packagedRegistry,
				fallbackRegistryPaths: [fallbackRegistry],
			}),
		).resolves.toBe(fallbackRegistry);
	});

	it("uses fallback registry probe paths when the bundled copy is absent", async () => {
		const fallbackRegistry = "/workspace/packages/registry/registry.json";
		mockIsFileAsync.mockImplementation(async (candidate: string) => {
			return candidate === fallbackRegistry;
		});

		await expect(
			locateRegistry({
				bundledRegistryPath: "/bundle/registry.json",
				fallbackRegistryPaths: [fallbackRegistry],
			}),
		).resolves.toBe(fallbackRegistry);
	});

	it("uses PEBBLES_REGISTRY from the environment when no flag is provided", async () => {
		vi.stubEnv("PEBBLES_REGISTRY", "https://example.com/env-registry.json");

		await expect(
			locateRegistry({
				bundledRegistryPath: "/bundle/registry.json",
			}),
		).resolves.toBe("https://example.com/env-registry.json");
	});

	it("uses a saved registry config when flag and env are absent", async () => {
		await expect(
			locateRegistry({
				savedRegistry: "https://example.com/saved-registry.json",
				bundledRegistryPath: "/bundle/registry.json",
			}),
		).resolves.toBe("https://example.com/saved-registry.json");
	});

	it("prefers PEBBLES_REGISTRY over a saved registry config", async () => {
		vi.stubEnv("PEBBLES_REGISTRY", "https://example.com/env-registry.json");

		await expect(
			locateRegistry({
				savedRegistry: "https://example.com/saved-registry.json",
				bundledRegistryPath: "/bundle/registry.json",
			}),
		).resolves.toBe("https://example.com/env-registry.json");
	});

	it("prefers an explicit flag over env and saved registry config", async () => {
		vi.stubEnv("PEBBLES_REGISTRY", "https://example.com/env-registry.json");

		await expect(
			locateRegistry({
				registry: "https://example.com/flag-registry.json",
				savedRegistry: "https://example.com/saved-registry.json",
				bundledRegistryPath: "/bundle/registry.json",
			}),
		).resolves.toBe("https://example.com/flag-registry.json");
	});

	it("defaults bundledRegistryPath relative to the module when omitted", async () => {
		const defaultBundledPath = path.resolve(
			__dirname,
			"../../",
			"registry.json",
		);
		mockIsFileAsync.mockImplementation(async (candidate: string) => {
			return candidate === defaultBundledPath;
		});

		await expect(locateRegistry()).resolves.toBe(defaultBundledPath);
	});

	it("defaults fallback registry paths relative to the workspace registry", async () => {
		const defaultFallbackPath = path.resolve(
			__dirname,
			"../../../registry/registry.json",
		);
		mockIsFileAsync.mockImplementation(async (candidate: string) => {
			return candidate === defaultFallbackPath;
		});

		await expect(
			locateRegistry({
				bundledRegistryPath: "/bundle/registry.json",
			}),
		).resolves.toBe(defaultFallbackPath);
	});

	it("throws a clear error when no registry source can be found", async () => {
		mockIsFileAsync.mockResolvedValue(false);

		await expect(
			locateRegistry({
				bundledRegistryPath: "/bundle/registry.json",
			}),
		).rejects.toThrow(
			"Registry not found (registry.json). Run `pnpm run build:registry` before using pebbles.",
		);
	});
});

describe("loadRuntimeRegistry", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal("fetch", mockFetch);
		mockParseRegistryDocument.mockReturnValue(sampleRegistry);
		mockFetchOk();
		Reflect.deleteProperty(process.env, "PEBBLES_REGISTRY");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("loads local registry sources from disk", async () => {
		mockReadFileAsync.mockResolvedValue(JSON.stringify(sampleRegistry));

		await expect(
			loadRuntimeRegistry("/workspace/registry.json"),
		).resolves.toEqual({
			registry: sampleRegistry,
			indexLocation: "/workspace/registry.json",
		});
		expect(mockReadFileAsync).toHaveBeenCalledWith("/workspace/registry.json");
		expect(mockParseRegistryDocument).toHaveBeenCalledWith(sampleRegistry);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rejects non-HTTPS remote registries", async () => {
		await expect(
			loadRuntimeRegistry("http://example.com/registry.json"),
		).rejects.toThrow("Remote registries must use HTTPS.");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rejects remote registries that include credentials", async () => {
		for (const location of [
			"https://user:secret@example.com/registry.json",
			"https://user@example.com/registry.json",
			"https://:secret@example.com/registry.json",
		]) {
			await expect(loadRuntimeRegistry(location)).rejects.toThrow(
				"Remote registries must not include credentials.",
			);
			expect(mockFetch).not.toHaveBeenCalled();
		}
	});

	it("rejects localhost remote registries including trailing-dot and .localhost", async () => {
		for (const location of [
			"https://localhost/registry.json",
			"https://localhost./registry.json",
			"https://registry.localhost/registry.json",
		]) {
			await expect(loadRuntimeRegistry(location)).rejects.toThrow(
				"Remote registries cannot target localhost.",
			);
			expect(mockFetch).not.toHaveBeenCalled();
		}
	});

	it("rejects literal IPv4 registry hosts", async () => {
		for (const host of ["127.0.0.1", "93.184.216.34", "192.168.0.1"]) {
			await expect(
				loadRuntimeRegistry(`https://${host}/registry.json`),
			).rejects.toThrow(
				"Remote registries must use a hostname, not an IP address.",
			);
			expect(mockFetch).not.toHaveBeenCalled();
		}
	});

	it("rejects literal IPv6 registry hosts", async () => {
		for (const host of ["[::1]", "[2001:db8::1]", "[::ffff:127.0.0.1]"]) {
			await expect(
				loadRuntimeRegistry(`https://${host}/registry.json`),
			).rejects.toThrow(
				"Remote registries must use a hostname, not an IP address.",
			);
			expect(mockFetch).not.toHaveBeenCalled();
		}
	});

	it("fetches and validates remote registries over HTTPS", async () => {
		mockFetchOk();

		await expect(
			loadRuntimeRegistry("https://example.com/registry.json"),
		).resolves.toEqual({
			registry: sampleRegistry,
			indexLocation: "https://example.com/registry.json",
		});
		expect(mockParseRegistryDocument).toHaveBeenCalled();
		expect(mockFetch).toHaveBeenCalledWith(
			expect.any(URL),
			expect.objectContaining({
				method: "GET",
				redirect: "error",
				headers: { accept: "application/json" },
			}),
		);
	});

	it("rejects redirect responses from remote registries", async () => {
		const redirectError = new TypeError(
			"fetch failed: redirect mode is set to error",
		);
		mockFetchOk({ rejectWith: redirectError });

		await expect(
			loadRuntimeRegistry("https://example.com/redirect-registry.json"),
		).rejects.toMatchObject({
			message: "Remote registries must not redirect.",
			cause: redirectError,
		});
	});

	it("rejects failed remote registry HTTP responses", async () => {
		mockFetchOk({
			status: 500,
			statusText: "Internal Server Error",
			headers: {},
			body: "server error",
		});

		await expect(
			loadRuntimeRegistry("https://example.com/missing-registry.json"),
		).rejects.toThrow("Failed to fetch registry (500 Internal Server Error).");
	});

	it("accepts Buffer bodies when reading a remote registry", async () => {
		mockFetchOk({
			headers: {},
			body: Buffer.from(publicRegistryBody),
		});

		await expect(
			loadRuntimeRegistry("https://example.com/buffer-registry.json"),
		).resolves.toEqual({
			registry: sampleRegistry,
			indexLocation: "https://example.com/buffer-registry.json",
		});
	});

	it("rejects remote registries whose content-length exceeds the size limit", async () => {
		mockFetchOk({
			headers: { "content-length": String(5_000_001) },
			body: publicRegistryBody,
		});

		await expect(
			loadRuntimeRegistry("https://example.com/large-header-registry.json"),
		).rejects.toThrow("Remote registry is too large.");
	});

	it("rejects remote registries with a non-integer content-length", async () => {
		mockFetchOk({
			headers: { "content-length": "not-a-number" },
			body: publicRegistryBody,
		});

		await expect(
			loadRuntimeRegistry("https://example.com/bad-length-registry.json"),
		).rejects.toThrow("Remote registry has an invalid Content-Length.");
		expect(mockParseRegistryDocument).not.toHaveBeenCalled();
	});

	it("accepts remote registries whose content-length equals the size limit", async () => {
		mockFetchOk({
			headers: { "content-length": String(5_000_000) },
			body: publicRegistryBody,
		});

		await expect(
			loadRuntimeRegistry("https://example.com/exact-header-registry.json"),
		).resolves.toEqual({
			registry: sampleRegistry,
			indexLocation: "https://example.com/exact-header-registry.json",
		});
	});

	it("rejects remote registries whose body exceeds the size limit", async () => {
		mockFetchOk({
			headers: {},
			body: "x".repeat(5_000_001),
		});

		await expect(
			loadRuntimeRegistry("https://example.com/large-body-registry.json"),
		).rejects.toThrow("Remote registry is too large.");
	});

	it("accepts remote registries whose body length equals the size limit", async () => {
		const exactBody = "x".repeat(5_000_000);
		mockFetchOk({
			headers: {},
			body: exactBody,
		});

		await expect(
			loadRuntimeRegistry("https://example.com/exact-body-registry.json"),
		).rejects.toThrow("Remote registry returned invalid JSON:");
	});

	it("rejects remote registries that return an empty body", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: {
				get: () => null,
			},
			body: null,
		});

		await expect(
			loadRuntimeRegistry("https://example.com/empty-body-registry.json"),
		).rejects.toThrow("Remote registry returned an empty body.");
	});

	it("skips empty chunks while reading a capped remote body", async () => {
		const payload = Buffer.from(publicRegistryBody);
		let reads = 0;
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: {
				get: () => null,
			},
			body: {
				getReader: () => ({
					read: async () => {
						reads += 1;
						if (reads === 1) return { done: false, value: undefined };
						if (reads === 2)
							return { done: false, value: new Uint8Array(payload) };
						return { done: true, value: undefined };
					},
					cancel: async () => {},
				}),
			},
		});
		mockParseRegistryDocument.mockReturnValue(sampleRegistry);

		await expect(
			loadRuntimeRegistry("https://example.com/chunked-registry.json"),
		).resolves.toEqual({
			registry: sampleRegistry,
			indexLocation: "https://example.com/chunked-registry.json",
		});
	});

	it("stringifies non-Error JSON parse failures from remote registries", async () => {
		mockFetchOk({
			headers: { "content-length": "2" },
			body: "{}",
		});
		vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
			throw "not-an-error";
		});

		await expect(
			loadRuntimeRegistry("https://example.com/weird-json-registry.json"),
		).rejects.toThrow("Remote registry returned invalid JSON: not-an-error");
	});

	it("maps request timeouts to an actionable error", async () => {
		const timeout = new Error("The operation was aborted");
		timeout.name = "TimeoutError";
		mockFetchOk({ rejectWith: timeout });

		await expect(
			loadRuntimeRegistry("https://example.com/slow-registry.json"),
		).rejects.toMatchObject({
			message:
				"Timed out fetching registry from https://example.com/slow-registry.json after 10s.",
			cause: timeout,
		});
	});

	it("maps abort errors to the same timeout message", async () => {
		const aborted = new Error("The operation was aborted");
		aborted.name = "AbortError";
		mockFetchOk({ rejectWith: aborted });

		await expect(
			loadRuntimeRegistry("https://example.com/aborted-registry.json"),
		).rejects.toMatchObject({
			message:
				"Timed out fetching registry from https://example.com/aborted-registry.json after 10s.",
			cause: aborted,
		});
	});

	it("wraps unexpected request failures with the registry URL", async () => {
		const failure = new Error("socket hang up");
		mockFetchOk({ rejectWith: failure });

		await expect(
			loadRuntimeRegistry("https://example.com/down-registry.json"),
		).rejects.toMatchObject({
			message:
				"Failed to fetch registry from https://example.com/down-registry.json.",
			cause: failure,
		});
	});

	it("wraps local registry read failures with a labeled error", async () => {
		const failure = new Error("ENOENT");
		mockReadFileAsync.mockRejectedValue(failure);

		await expect(
			loadRuntimeRegistry("/workspace/registry.json"),
		).rejects.toMatchObject({
			message: "Failed to read registry at /workspace/registry.json: ENOENT",
			cause: failure,
		});
	});

	it("stringifies non-Error local registry read failures", async () => {
		mockReadFileAsync.mockRejectedValue("disk-full");

		await expect(
			loadRuntimeRegistry("/workspace/registry.json"),
		).rejects.toThrow(
			"Failed to read registry at /workspace/registry.json: disk-full",
		);
	});

	it("propagates labeled local registry JSON parse failures", async () => {
		mockReadFileAsync.mockResolvedValue("{ not json");

		await expect(
			loadRuntimeRegistry("/workspace/registry.json"),
		).rejects.toBeInstanceOf(InvalidJsonError);
	});

	it("wraps non-SyntaxError local JSON parse failures", async () => {
		mockReadFileAsync.mockResolvedValue("{}");
		const failure = new Error("unexpected parse boom");
		vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
			throw failure;
		});

		await expect(
			loadRuntimeRegistry("/workspace/registry.json"),
		).rejects.toMatchObject({
			message:
				"Failed to read registry at /workspace/registry.json: unexpected parse boom",
			cause: failure,
		});
	});
});

describe("loadCompiledItems", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal("fetch", mockFetch);
		mockFetchOk();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	/**
	 * Build an itemIntegrity map for one catalog source and its JSON body.
	 * @param source - Catalog source URI.
	 * @param body - Exact JSON bytes that will be read or fetched.
	 * @returns Integrity map for {@link loadCompiledItems}.
	 */
	function digestFor(source: string, body: string): Record<string, string> {
		return { [source]: sha256Integrity(body) };
	}

	it("loads unique payloads relative to the given index location", async () => {
		const body = JSON.stringify({
			files: [{ target: "a.txt", content: "hello" }],
		});
		mockReadFileAsync.mockResolvedValueOnce(body);

		const payloads = await loadCompiledItems(
			"/workspace/registry.json",
			["r/item.json", "r/item.json"],
			digestFor("r/item.json", body),
		);

		expect(payloads.size).toBe(1);
		expect(payloads.get("r/item.json")).toEqual({
			files: [{ target: "a.txt", content: "hello" }],
		});
		expect(mockReadFileAsync).toHaveBeenCalledWith("/workspace/r/item.json");
	});

	it("returns an empty map when no compiled item sources are provided", async () => {
		const payloads = await loadCompiledItems("/workspace/registry.json", []);

		expect(payloads.size).toBe(0);
		expect(mockReadFileAsync).not.toHaveBeenCalled();
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("loads remote payloads relative to an HTTPS registry", async () => {
		const body = JSON.stringify({
			files: [{ target: "b.txt", content: "remote" }],
		});
		mockFetchOk({ body });

		const payloads = await loadCompiledItems(
			"https://example.com/registry.json",
			["r/item.json"],
			digestFor("r/item.json", body),
		);

		expect(payloads.get("r/item.json")).toEqual({
			files: [{ target: "b.txt", content: "remote" }],
		});
		expect(mockFetch).toHaveBeenCalledWith(
			new URL("https://example.com/r/item.json"),
			expect.objectContaining({ method: "GET", redirect: "error" }),
		);
	});

	it("rejects absolute HTTPS compiled item sources against a local index", async () => {
		await expect(
			loadCompiledItems("/workspace/registry.json", [
				"https://cdn.example.com/abs.json",
			]),
		).rejects.toThrow("must be a relative path under a local registry");
	});

	it("loads same-origin absolute HTTPS compiled item sources for a remote index", async () => {
		const body = JSON.stringify({
			files: [{ target: "abs.txt", content: "b" }],
		});
		mockFetchOk({ body });

		const payloads = await loadCompiledItems(
			"https://example.com/registry.json",
			["https://example.com/abs.json"],
			digestFor("https://example.com/abs.json", body),
		);

		expect(payloads.get("https://example.com/abs.json")).toEqual({
			files: [{ target: "abs.txt", content: "b" }],
		});
		expect(mockFetch).toHaveBeenCalledWith(
			new URL("https://example.com/abs.json"),
			expect.objectContaining({ method: "GET" }),
		);
	});

	it("surfaces the payload label when a remote payload fetch fails", async () => {
		mockFetchOk({
			status: 404,
			statusText: "Not Found",
			headers: {},
			body: "missing",
		});

		await expect(
			loadCompiledItems("https://example.com/registry.json", [
				"r/missing.json",
			]),
		).rejects.toThrow("Failed to fetch compiled item (404 Not Found).");
	});

	it("propagates labeled local payload JSON parse failures", async () => {
		const body = "{ not json";
		mockReadFileAsync.mockResolvedValueOnce(body);

		await expect(
			loadCompiledItems(
				"/workspace/registry.json",
				["r/bad.json"],
				digestFor("r/bad.json", body),
			),
		).rejects.toBeInstanceOf(InvalidJsonError);
	});

	it("rejects a local compiled item that exceeds the size limit", async () => {
		const body = "x".repeat(5_000_001);
		mockReadFileAsync.mockResolvedValueOnce(body);

		await expect(
			loadCompiledItems("/workspace/registry.json", ["r/huge.json"]),
		).rejects.toThrow("compiled item at /workspace/r/huge.json is too large.");
	});

	it("rejects compiled items when itemIntegrity is omitted", async () => {
		const body = JSON.stringify({
			files: [{ target: "a.txt", content: "hello" }],
		});
		mockReadFileAsync.mockResolvedValueOnce(body);

		await expect(
			loadCompiledItems("/workspace/registry.json", ["r/item.json"]),
		).rejects.toThrow("Missing integrity digest for item r/item.json");
	});

	it("rejects a compiled item whose digest does not match", async () => {
		const body = JSON.stringify({
			files: [{ target: "a.txt", content: "hello" }],
		});
		mockReadFileAsync.mockResolvedValueOnce(body);

		await expect(
			loadCompiledItems("/workspace/registry.json", ["r/item.json"], {
				"r/item.json": sha256Integrity("other"),
			}),
		).rejects.toThrow("Integrity check failed for item r/item.json");
	});

	it("rejects a compiled item that is not a compiled item document", async () => {
		const body = JSON.stringify({ unexpected: true });
		mockReadFileAsync.mockResolvedValueOnce(body);

		await expect(
			loadCompiledItems(
				"/workspace/registry.json",
				["r/item.json"],
				digestFor("r/item.json", body),
			),
		).rejects.toThrow('Compiled item "r/item.json"');
	});
});
