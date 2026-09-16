import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	assertSafeRemoteUrl,
	assertSinglePathSegment,
	isAbsoluteHttpUrl,
	isEscapingRelativePath,
	isNonRelativePath,
	joinIndexSource,
	joinRelativePathUnderRoot,
	publishedRegistryUrl,
} from "./urls";

describe("isAbsoluteHttpUrl", () => {
	it("accepts http and https URLs", () => {
		expect(isAbsoluteHttpUrl("https://example.com/file.ts")).toBe(true);
		expect(isAbsoluteHttpUrl("http://example.com/file.ts")).toBe(true);
		expect(isAbsoluteHttpUrl("HTTPS://EXAMPLE.COM/FILE.TS")).toBe(true);
	});

	it("rejects relative paths and non-http schemes", () => {
		expect(isAbsoluteHttpUrl("registry/file.ts")).toBe(false);
		expect(isAbsoluteHttpUrl("/absolute/path.ts")).toBe(false);
		expect(isAbsoluteHttpUrl("ftp://example.com/file.ts")).toBe(false);
		expect(isAbsoluteHttpUrl("prefixhttps://example.com/file.ts")).toBe(false);
	});
});

describe("isEscapingRelativePath", () => {
	it("accepts safe relative paths", () => {
		expect(isEscapingRelativePath("foo")).toBe(false);
		expect(isEscapingRelativePath("foo/bar/baz.json")).toBe(false);
		expect(isEscapingRelativePath("./foo/bar")).toBe(false);
	});

	it("rejects root-relative and POSIX absolute paths", () => {
		expect(isEscapingRelativePath("/foo/bar")).toBe(true);
		expect(isEscapingRelativePath("/")).toBe(true);
	});

	it("rejects backslash separators and Windows paths", () => {
		expect(isEscapingRelativePath("foo\\bar")).toBe(true);
		expect(isEscapingRelativePath("C:\\foo\\bar")).toBe(true);
		expect(isEscapingRelativePath("C:/foo/bar")).toBe(true);
		expect(isEscapingRelativePath("C:foo/bar")).toBe(true);
		expect(isEscapingRelativePath("d:relative")).toBe(true);
	});

	it("rejects parent directory traversals", () => {
		expect(isEscapingRelativePath("../foo")).toBe(true);
		expect(isEscapingRelativePath("foo/../bar")).toBe(true);
		expect(isEscapingRelativePath("..")).toBe(true);
	});

	it("rejects absolute URLs", () => {
		expect(isEscapingRelativePath("https://example.com/item.json")).toBe(true);
		expect(isEscapingRelativePath("http://example.com/item.json")).toBe(true);
	});
});

describe("isNonRelativePath", () => {
	it("accepts relative paths including parent segments", () => {
		expect(isNonRelativePath("foo/bar.ts")).toBe(false);
		expect(isNonRelativePath("../shared.ts")).toBe(false);
		expect(isNonRelativePath("foo/../bar.ts")).toBe(false);
	});

	it("rejects absolute, backslash, Windows, and URL paths", () => {
		expect(isNonRelativePath("/abs.ts")).toBe(true);
		expect(isNonRelativePath("foo\\bar.ts")).toBe(true);
		expect(isNonRelativePath("C:/foo.ts")).toBe(true);
		expect(isNonRelativePath("https://example.com/h.js")).toBe(true);
	});
});

describe("assertSinglePathSegment", () => {
	it("accepts valid single path segments", () => {
		expect(() => assertSinglePathSegment("Test", "valid-name")).not.toThrow();
		expect(() => assertSinglePathSegment("Test", "feature_123")).not.toThrow();
		expect(() => assertSinglePathSegment("Test", "config.json")).not.toThrow();
	});

	it("rejects empty strings", () => {
		expect(() => assertSinglePathSegment("Option", "")).toThrow(
			'Option must be a single path segment (no "/", "\\", or "..").',
		);
	});

	it("rejects dot and double-dot segments", () => {
		expect(() => assertSinglePathSegment("Option", ".")).toThrow(
			'Option must be a single path segment (no "/", "\\", or "..").',
		);
		expect(() => assertSinglePathSegment("Option", "..")).toThrow(
			'Option must be a single path segment (no "/", "\\", or "..").',
		);
	});

	it("rejects forward slash and backslash separators", () => {
		expect(() => assertSinglePathSegment("Option", "foo/bar")).toThrow(
			'Option must be a single path segment (no "/", "\\", or "..").',
		);
		expect(() => assertSinglePathSegment("Option", "foo\\bar")).toThrow(
			'Option must be a single path segment (no "/", "\\", or "..").',
		);
	});
});

describe("assertSafeRemoteUrl", () => {
	it("accepts a public HTTPS hostname", () => {
		expect(() =>
			assertSafeRemoteUrl(new URL("https://example.com/registry.json")),
		).not.toThrow();
	});

	it("rejects non-HTTPS protocols", () => {
		expect(() =>
			assertSafeRemoteUrl(new URL("http://example.com/registry.json")),
		).toThrow("Remote registries must use HTTPS.");
	});

	it("rejects credentials in the URL", () => {
		expect(() =>
			assertSafeRemoteUrl(
				new URL("https://user:secret@example.com/registry.json"),
			),
		).toThrow("Remote registries must not include credentials.");
		expect(() =>
			assertSafeRemoteUrl(new URL("https://user@example.com/registry.json")),
		).toThrow("Remote registries must not include credentials.");
		expect(() =>
			assertSafeRemoteUrl(new URL("https://:secret@example.com/registry.json")),
		).toThrow("Remote registries must not include credentials.");
	});

	it("rejects localhost and .localhost hosts", () => {
		for (const location of [
			"https://localhost/registry.json",
			"https://localhost./registry.json",
			"https://registry.localhost/registry.json",
		]) {
			expect(() => assertSafeRemoteUrl(new URL(location))).toThrow(
				"Remote registries cannot target localhost.",
			);
		}
	});

	it("rejects literal IP hosts", () => {
		for (const location of [
			"https://127.0.0.1/registry.json",
			"https://[::1]/registry.json",
			"https://[2001:db8::1]/registry.json",
		]) {
			expect(() => assertSafeRemoteUrl(new URL(location))).toThrow(
				"Remote registries must use a hostname, not an IP address.",
			);
		}
	});

	it("does not treat bracket-like hostnames as IPv6 unless fully bracketed", () => {
		// Valid WHATWG URLs cannot end with a lone "]", so pass a URL-shaped object.
		expect(() =>
			assertSafeRemoteUrl({
				protocol: "https:",
				username: "",
				password: "",
				hostname: "example.com]",
			} as URL),
		).not.toThrow();
		expect(() =>
			assertSafeRemoteUrl({
				protocol: "https:",
				username: "",
				password: "",
				hostname: "[example.com",
			} as URL),
		).not.toThrow();
	});
});

describe("joinRelativePathUnderRoot", () => {
	it("joins a relative path under the root", () => {
		expect(
			joinRelativePathUnderRoot(
				"/tmp/root",
				"r/item.json",
				"Payload",
				"registry directory",
			),
		).toBe(path.join("/tmp/root", "r/item.json"));
	});

	it("rejects empty, absolute, backslash, and escaping paths", () => {
		expect(() =>
			joinRelativePathUnderRoot(
				"/tmp/root",
				"  ",
				"Payload",
				"registry directory",
			),
		).toThrow("Payload must not be empty.");
		expect(() =>
			joinRelativePathUnderRoot(
				"/tmp/root",
				"/etc/passwd",
				"Payload",
				"registry directory",
			),
		).toThrow("must be a relative path under the registry directory");
		expect(() =>
			joinRelativePathUnderRoot(
				"/tmp/root",
				"foo\\bar.txt",
				"Payload",
				"registry directory",
			),
		).toThrow("must be a relative path under the registry directory");
		expect(() =>
			joinRelativePathUnderRoot(
				"/tmp/root",
				"../secret.json",
				"Payload",
				"registry directory",
			),
		).toThrow("must be a relative path under the registry directory");
	});

	it("allows parent segments when resolved from a nested folder under the root", () => {
		expect(
			joinRelativePathUnderRoot(
				"/tmp/root",
				"../shared.ts",
				"Script",
				"registry source",
				"/tmp/root/agent-instructions/code-standards",
			),
		).toBe(path.join("/tmp/root", "agent-instructions/shared.ts"));
	});

	it("rejects parent segments that escape the containment root", () => {
		expect(() =>
			joinRelativePathUnderRoot(
				"/tmp/root",
				"../../../etc/passwd",
				"Script",
				"registry source",
				"/tmp/root/agent-instructions/code-standards",
			),
		).toThrow('Script "../../../etc/passwd" escapes the registry source.');
	});
});

describe("publishedRegistryUrl", () => {
	it("builds the release-tag index URL for a version", () => {
		expect(publishedRegistryUrl("1.2.3")).toBe(
			"https://raw.githubusercontent.com/agrawal-rohit/pebbles/pebbles@1.2.3/packages/registry/registry.json",
		);
	});
});

describe("joinIndexSource", () => {
	it("passes same-origin absolute payload URLs through unchanged", () => {
		expect(
			joinIndexSource(
				"https://example.com/registry.json",
				"https://example.com/payloads/button.json",
			),
		).toBe("https://example.com/payloads/button.json");
	});

	it("rejects cross-origin absolute payload URLs", () => {
		expect(() =>
			joinIndexSource(
				"https://example.com/registry.json",
				"https://cdn.example.com/payloads/button.json",
			),
		).toThrow("must stay on the same origin as the registry index");
	});

	it("rejects absolute URLs against a local registry index", () => {
		expect(() =>
			joinIndexSource(
				"/tmp/my-registry/registry.json",
				"  https://cdn.example.com/payloads/button.json  ",
			),
		).toThrow("must be a relative path under a local registry");
	});

	it("trims whitespace before treating a same-origin source as an absolute URL", () => {
		expect(
			joinIndexSource(
				"https://example.com/registry.json",
				"  https://example.com/payloads/button.json  ",
			),
		).toBe("https://example.com/payloads/button.json");
	});

	it("joins relative payloads against an http(s) index URL", () => {
		expect(
			joinIndexSource(
				"https://example.com/reg/registry.json",
				"r/button/react.json",
			),
		).toBe("https://example.com/reg/r/button/react.json");
	});

	it("joins relative payloads against a local registry path", () => {
		const catalog = "/tmp/my-registry/registry.json";
		expect(joinIndexSource(catalog, "r/button/react.json")).toBe(
			"/tmp/my-registry/r/button/react.json",
		);
	});

	it("rejects local path traversal", () => {
		expect(() =>
			joinIndexSource("/tmp/my-registry/registry.json", "../secret.json"),
		).toThrow('Registry file source "../secret.json" must be a relative path');
	});

	it("rejects an empty file source", () => {
		expect(() =>
			joinIndexSource("/tmp/my-registry/registry.json", "   "),
		).toThrow("Registry file source must not be empty.");
	});

	it("rejects an empty index location", () => {
		expect(() => joinIndexSource("  ", "r/button/react.json")).toThrow(
			"Registry index location must not be empty.",
		);
	});

	it("rejects absolute local source paths", () => {
		expect(() =>
			joinIndexSource("/tmp/my-registry/registry.json", "/etc/passwd"),
		).toThrow(
			'Registry file source "/etc/passwd" must be a relative path under the registry directory.',
		);
	});

	it("rejects sources that escape the registry directory after joining", () => {
		const relativeSpy = vi
			.spyOn(path, "relative")
			.mockReturnValueOnce("../escaped.json");

		try {
			expect(() =>
				joinIndexSource(
					"/tmp/my-registry/registry.json",
					"r/button/react.json",
				),
			).toThrow(
				'Registry file source "r/button/react.json" escapes the registry directory.',
			);
		} finally {
			relativeSpy.mockRestore();
		}
	});

	it("rejects sources whose joined relative path is absolute", () => {
		const relativeSpy = vi
			.spyOn(path, "relative")
			.mockReturnValueOnce("/absolute/escape.json");

		try {
			expect(() =>
				joinIndexSource(
					"/tmp/my-registry/registry.json",
					"r/button/react.json",
				),
			).toThrow(
				'Registry file source "r/button/react.json" escapes the registry directory.',
			);
		} finally {
			relativeSpy.mockRestore();
		}
	});
});
