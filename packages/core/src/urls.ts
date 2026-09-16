import { isIP } from "node:net";
import path from "node:path";

/**
 * Check whether a string is an absolute HTTP(S) URL.
 * @param value - Candidate URL or path.
 * @returns True when the value starts with `http://` or `https://`.
 */
export function isAbsoluteHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

/**
 * True when a path is absolute, uses backslashes, or is an HTTP(S) URL.
 * Parent segments (`..`) are allowed; callers that need a containment root must
 * resolve the path and check it with {@link joinRelativePathUnderRoot}.
 * @param value - Candidate path.
 * @returns Whether the path is not a relative POSIX path.
 */
export function isNonRelativePath(value: string): boolean {
	return (
		value.startsWith("/") ||
		value.includes("\\") ||
		isAbsoluteHttpUrl(value) ||
		/^[a-zA-Z]:/.test(value)
	);
}

/**
 * True when a relative path would escape its root or is an absolute/URL form.
 * The checks are platform-independent so registry documents validate identically on every OS.
 * @param value - Candidate relative path.
 * @returns Whether the path is unsafe as a registry or project-relative path.
 */
export function isEscapingRelativePath(value: string): boolean {
	return isNonRelativePath(value) || value.split("/").includes("..");
}

/**
 * Reject absolute http(s) compiled `source` values that leave the index origin.
 * Local indexes reject absolute URLs entirely; remote indexes require the same origin
 * (in addition to {@link assertSafeRemoteUrl} on the resolved fetch URL).
 * @param indexLocation - Absolute path or http(s) URL of registry.json.
 * @param source - Candidate source URI.
 * @throws Error when the source is a disallowed cross-origin absolute URL.
 */
export function assertSameOriginIndexSource(
	indexLocation: string,
	source: string,
): void {
	const trimmedSource = source.trim();
	if (!isAbsoluteHttpUrl(trimmedSource)) return;

	if (!isAbsoluteHttpUrl(indexLocation))
		throw new Error(
			`Registry file source "${source}" must be a relative path under a local registry (absolute URLs are not allowed).`,
		);

	const indexUrl = new URL(indexLocation);
	const sourceUrl = new URL(trimmedSource);
	if (indexUrl.origin !== sourceUrl.origin)
		throw new Error(
			`Registry file source "${source}" must stay on the same origin as the registry index (${indexUrl.origin}).`,
		);
}

/**
 * Join an index item or variant `source` against the index location.
 * @param indexLocation - Absolute path or http(s) URL of `registry.json`.
 * @param source - Opaque URI from a compiled index item or variant `source`.
 * @returns Absolute http(s) URL or absolute local filesystem path.
 * @throws Error when a local relative source escapes the registry directory,
 *   or an absolute source is cross-origin / disallowed for local indexes.
 */
export function joinIndexSource(indexLocation: string, source: string): string {
	const trimmedSource = source.trim();
	if (!trimmedSource)
		throw new Error("Registry file source must not be empty.");

	assertSameOriginIndexSource(indexLocation, trimmedSource);
	if (isAbsoluteHttpUrl(trimmedSource)) return trimmedSource;

	const trimmedIndexLocation = indexLocation.trim();
	if (!trimmedIndexLocation)
		throw new Error("Registry index location must not be empty.");

	// Remote registries: WHATWG URL path joining (…/registry.json + r/x.json → …/r/x.json).
	if (isAbsoluteHttpUrl(trimmedIndexLocation))
		return new URL(trimmedSource, trimmedIndexLocation).href;

	const indexDir = path.dirname(path.resolve(trimmedIndexLocation));
	return joinRelativePathUnderRoot(
		indexDir,
		trimmedSource,
		"Registry file source",
		"registry directory",
	);
}

/**
 * Reject remote registry URLs whose host looks internal or unsafe to fetch blindly.
 *
 * Validates the URL string only (no DNS lookup): HTTPS, no embedded credentials,
 * no `localhost` / `*.localhost`, and no IP literals (IPv4 or IPv6). Hostnames
 * that resolve to private, link-local, or metadata addresses are not checked.
 *
 * @param url - Parsed remote URL.
 * @throws Error when the URL uses a disallowed protocol, credentials, localhost, or IP host.
 */
export function assertSafeRemoteUrl(url: URL): void {
	if (url.protocol !== "https:")
		throw new Error("Remote registries must use HTTPS.");
	if (url.username || url.password)
		throw new Error("Remote registries must not include credentials.");

	const host = url.hostname.replace(/\.$/, "").toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost"))
		throw new Error("Remote registries cannot target localhost.");

	// WHATWG URL.hostname keeps brackets on IPv6 literals (e.g. "[::1]").
	const literal =
		url.hostname.startsWith("[") && url.hostname.endsWith("]")
			? url.hostname.slice(1, -1)
			: url.hostname;
	if (isIP(literal))
		throw new Error(
			"Remote registries must use a hostname, not an IP address.",
		);
}

/**
 * Index URL for the published default registry at a release tag.
 * @param version - Published CLI / registry package version (used in the `cheetos@` tag).
 * @returns Absolute HTTPS URL to `packages/registry/registry.json`.
 */
export function publishedRegistryUrl(version: string): string {
	return `https://raw.githubusercontent.com/agrawal-rohit/cheetos/cheetos@${version}/packages/registry/registry.json`;
}

/**
 * Fail when a value is empty, `.`, `..`, or contains a path separator.
 * @param label - Noun phrase for the error (option name or `"Kind \"id\""` style label).
 * @param value - Candidate single path segment.
 * @throws Error when the value is not a single path segment.
 */
export function assertSinglePathSegment(label: string, value: string): void {
	if (
		!value ||
		value === "." ||
		value === ".." ||
		value.includes("/") ||
		value.includes("\\")
	)
		throw new Error(
			String.raw`${label} must be a single path segment (no "/", "\", or "..").`,
		);
}

/**
 * Join a relative path under a root directory, rejecting escapes and absolute inputs.
 * Pass `fromDir` when the path is relative to a nested folder (e.g. an item folder)
 * but must still stay under `rootDir` (e.g. the registry source). That allows `..`
 * to reach a parent folder without leaving the containment root.
 * @param rootDir - Absolute directory the result must stay under.
 * @param relativePath - Candidate relative path (may include surrounding whitespace).
 * @param label - Noun phrase used in error messages (e.g. `"Compiled item file target"`).
 * @param rootLabel - Human label for the root (e.g. `"project directory"`).
 * @param fromDir - Directory to resolve `relativePath` against. Defaults to `rootDir`.
 *   When set, `..` segments are allowed as long as the resolved path stays under `rootDir`.
 * @returns Absolute path under `rootDir`.
 * @throws Error when the path is empty, absolute, or escapes `rootDir`.
 */
export function joinRelativePathUnderRoot(
	rootDir: string,
	relativePath: string,
	label: string,
	rootLabel: string,
	fromDir: string = rootDir,
): string {
	const trimmed = relativePath.trim();
	if (!trimmed) throw new Error(`${label} must not be empty.`);

	// Nested fromDir: allow `..` so scripts can live in a parent folder of the caller.
	// Same-dir joins keep the lexical `..` ban so catalog URIs cannot walk out of `r/`.
	const unsafe =
		fromDir === rootDir
			? isEscapingRelativePath(trimmed)
			: isNonRelativePath(trimmed);
	if (unsafe)
		throw new Error(
			`${label} "${relativePath}" must be a relative path under the ${rootLabel}.`,
		);

	const absolutePath = path.resolve(fromDir, trimmed);
	const relative = path.relative(rootDir, absolutePath);
	if (relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error(`${label} "${relativePath}" escapes the ${rootLabel}.`);

	return absolutePath;
}
