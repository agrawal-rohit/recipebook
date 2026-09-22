import { describe, expect, test } from "vitest";
import {
	assertSafeRemoteUrl,
	assertSameOriginIndexSource,
	assertSinglePathSegment,
	isAbsoluteHttpUrl,
	isEscapingRelativePath,
	isNonRelativePath,
	joinIndexSource,
	joinRelativePathUnderRoot,
} from "./urls";

describe("path classification guards", () => {
	test("it should accept http and https absolute URLs case-insensitively when asked whether a value is a URL because registries may quote sources in any case", () => {
		expect(isAbsoluteHttpUrl("https://example.com/registry.json")).toBe(true);
		expect(isAbsoluteHttpUrl("HTTP://example.com/registry.json")).toBe(true);
		expect(isAbsoluteHttpUrl("/tmp/registry.json")).toBe(false);
		expect(isAbsoluteHttpUrl("ftp://example.com")).toBe(false);
	});

	test("it should treat absolute paths, drive letters, backslashes, and URLs as non-relative when validating paths because registry documents must validate identically on every OS", () => {
		expect(isNonRelativePath("/abs")).toBe(true);
		expect(isNonRelativePath("C:\\abs")).toBe(true);
		expect(isNonRelativePath("C:/abs")).toBe(true);
		expect(isNonRelativePath("a\\b")).toBe(true);
		expect(isNonRelativePath("https://example.com/x")).toBe(true);
		expect(isNonRelativePath("r/x.json")).toBe(false);
		expect(isNonRelativePath("../r/x.json")).toBe(false);
	});

	test("it should reject parent-directory segments, absolute forms, and URLs as escaping when validating registry-relative paths because targets must stay under their root", () => {
		expect(isEscapingRelativePath("../x")).toBe(true);
		expect(isEscapingRelativePath("x/../y")).toBe(true);
		expect(isEscapingRelativePath("/x")).toBe(true);
		expect(isEscapingRelativePath("https://example.com/x")).toBe(true);
		expect(isEscapingRelativePath("r/x.json")).toBe(false);
	});
});

describe("assertSinglePathSegment", () => {
	test("it should reject empty, dot, parent, and separator-bearing segments because item ids become payload paths under the registry", () => {
		for (const bad of ["", ".", "..", "a/b", "a\\b"]) {
			expect(() => assertSinglePathSegment("Item id", bad)).toThrow(
				'Item id must be a single path segment (no "/", "\\", or "..").',
			);
		}
		expect(() => assertSinglePathSegment("Item id", "button")).not.toThrow();
		expect(() =>
			assertSinglePathSegment("Item id", "data-table"),
		).not.toThrow();
	});
});

describe("assertSafeRemoteUrl", () => {
	test("it should accept an https hostname URL because that is the only shape safe to fetch blindly", () => {
		expect(() =>
			assertSafeRemoteUrl(new URL("https://example.com/registry.json")),
		).not.toThrow();
		// Trailing-dot hostnames are equivalent to the bare hostname.
		expect(() =>
			assertSafeRemoteUrl(new URL("https://example.com./registry.json")),
		).not.toThrow();
	});

	test("it should reject http URLs when fetching remote registries because plain HTTP allows downgrade attacks", () => {
		expect(() =>
			assertSafeRemoteUrl(new URL("http://example.com/registry.json")),
		).toThrowError("Remote registries must use HTTPS.");
	});

	test("it should reject URLs with embedded credentials when fetching remote registries because secrets in URLs leak and enable imposters", () => {
		expect(() =>
			assertSafeRemoteUrl(
				new URL("https://user:pass@example.com/registry.json"),
			),
		).toThrowError("Remote registries must not include credentials.");
	});

	test("it should reject localhost hosts including subdomains when fetching remote registries because localhost endpoints are local to the user's machine", () => {
		expect(() =>
			assertSafeRemoteUrl(new URL("https://localhost/registry.json")),
		).toThrowError("Remote registries cannot target localhost.");
		expect(() =>
			assertSafeRemoteUrl(new URL("https://api.localhost/registry.json")),
		).toThrowError("Remote registries cannot target localhost.");
	});

	test("it should reject IP-literal hosts (IPv4 and IPv6) when fetching remote registries because hostnames are required to keep SSRF guards meaningful", () => {
		expect(() =>
			assertSafeRemoteUrl(new URL("https://127.0.0.1/registry.json")),
		).toThrowError("Remote registries must use a hostname, not an IP address.");
		expect(() =>
			assertSafeRemoteUrl(new URL("https://[::1]/registry.json")),
		).toThrowError("Remote registries must use a hostname, not an IP address.");
	});
});

describe("assertSameOriginIndexSource", () => {
	test("it should accept relative sources regardless of the index location because relative sources are joined later by joinIndexSource", () => {
		expect(() =>
			assertSameOriginIndexSource(
				"https://example.com/registry.json",
				"r/a.json",
			),
		).not.toThrow();
		expect(() =>
			assertSameOriginIndexSource("/registry.json", "r/a.json"),
		).not.toThrow();
	});

	test("it should accept an absolute source on the same origin as the index because same-origin payloads are the index author's own content", () => {
		expect(() =>
			assertSameOriginIndexSource(
				"https://example.com/registry.json",
				"https://example.com/r/a.json",
			),
		).not.toThrow();
	});

	test("it should reject a cross-origin absolute source when the index is remote because payloads must not be fetched from unrelated hosts", () => {
		expect(() =>
			assertSameOriginIndexSource(
				"https://example.com/registry.json",
				"https://other.com/r/a.json",
			),
		).toThrowError(/must stay on the same origin as the registry index/);
	});

	test("it should reject an absolute URL source when the index is local because local registries ship their payloads as files, not URLs", () => {
		expect(() =>
			assertSameOriginIndexSource(
				"/registry.json",
				"https://example.com/r/a.json",
			),
		).toThrowError(/must be a relative path under a local registry/);
	});
});

describe("joinRelativePathUnderRoot", () => {
	const root = "/registry";

	test("it should resolve a plain relative path under the root when joining because payloads live below their containment root", () => {
		expect(
			joinRelativePathUnderRoot(
				root,
				"r/button.json",
				"Source",
				"registry directory",
			),
		).toBe("/registry/r/button.json");
	});

	test("it should trim surrounding whitespace before joining because registry authors may pad path fields", () => {
		expect(
			joinRelativePathUnderRoot(
				root,
				"  r/button.json  ",
				"Source",
				"registry directory",
			),
		).toBe("/registry/r/button.json");
	});

	test("it should reject empty, parent-directory, and absolute paths (same-dir join) because lexical escapes must never reach the filesystem", () => {
		expect(() =>
			joinRelativePathUnderRoot(root, "", "Source", "registry directory"),
		).toThrowError(/must not be empty\./);
		for (const bad of ["../x.json", "/etc/hosts", "https://example.com/x"]) {
			expect(() =>
				joinRelativePathUnderRoot(root, bad, "Source", "registry directory"),
			).toThrowError(/must be a relative path under the registry directory\./);
		}
	});

	test("it should allow parent-directory steps from a nested fromDir when the resolved path stays under the root because shared hooks may live above an item folder", () => {
		expect(
			joinRelativePathUnderRoot(
				root,
				"../../shared.js",
				"Script URI",
				"registry directory",
				`${root}/r/item`,
			),
		).toBe(`${root}/shared.js`);
	});

	test("it should reject a nested fromDir resolution that escapes the root because containment still applies to nested joins", () => {
		expect(() =>
			joinRelativePathUnderRoot(
				root,
				"../../../escape.js",
				"Script URI",
				"registry directory",
				`${root}/r/item`,
			),
		).toThrowError(/escapes the registry directory\./);
	});
});

describe("joinIndexSource", () => {
	test("it should join a relative source against a local index directory because item sources resolve relative to registry.json", () => {
		expect(joinIndexSource("/registry/registry.json", "r/button.json")).toBe(
			"/registry/r/button.json",
		);
	});

	test("it should join a relative source against a remote index URL using URL semantics because WHATWG resolution matches browser expectations", () => {
		expect(
			joinIndexSource("https://example.com/i/registry.json", "r/button.json"),
		).toBe("https://example.com/i/r/button.json");
	});

	test("it should keep an absolute same-origin source unchanged when the index is remote because it is already fully qualified", () => {
		expect(
			joinIndexSource(
				"https://example.com/registry.json",
				"https://example.com/r/button.json",
			),
		).toBe("https://example.com/r/button.json");
	});

	test("it should reject an empty source because an empty URI cannot name a payload", () => {
		expect(() => joinIndexSource("/registry.json", "   ")).toThrowError(
			"Registry file source must not be empty.",
		);
	});

	test("it should reject a source that escapes the registry directory because a local registry must not read outside its own tree", () => {
		expect(() =>
			joinIndexSource("/registry/registry.json", "../outside.json"),
		).toThrowError(/must be a relative path under the registry directory\./);
	});

	test("it should reject a cross-origin absolute source when the index is remote because payloads must stay on the index origin", () => {
		expect(() =>
			joinIndexSource(
				"https://example.com/registry.json",
				"https://other.com/r/a.json",
			),
		).toThrowError(/must stay on the same origin as the registry index/);
	});
});
