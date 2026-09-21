import path from "node:path";
import {
	assertSafeRemoteUrl,
	type CompiledItem,
	compiledItemSchema,
	InvalidJsonError,
	isAbsoluteHttpUrl,
	joinIndexSource,
	parseRegistryDocument,
	parseWithSchema,
	type Registry,
	readFileAsync,
	verifyItemIntegrity,
} from "@cheetos/core";
import { NoRegistrySourceError } from "../cli/errors";

/** Maximum JSON document size for registry indexes and compiled items. */
const JSON_DOCUMENT_BYTE_LIMIT = 5_000_000;

export interface LocateRegistryOptions {
	/** Explicit registry flag value from the CLI. */
	registry?: string;
	/** Registry source persisted via `cheetos configure set`. */
	savedRegistry?: string;
}

/** Parsed registry paired with the location it was loaded from. */
export interface LoadedRegistry {
	/** Normalized registry document. */
	registry: Registry;
	/** Absolute path or HTTPS URL of the index document. */
	indexLocation: string;
}

/**
 * Locate which registry the CLI should use.
 * @param options - Inputs from CLI flags, env, and saved config.
 * @returns Absolute local path or HTTPS URL to the index.
 * @throws {@link NoRegistrySourceError} when no explicit source resolves, or an explicit HTTPS URL fails {@link assertSafeRemoteUrl}.
 */
export async function locateRegistry(
	options: LocateRegistryOptions = {},
): Promise<string> {
	// Source reading order: CLI flag > env > saved config. Explicit sources only.
	const source =
		options.registry ?? process.env.CHEETOS_REGISTRY ?? options.savedRegistry;

	if (source) {
		if (isAbsoluteHttpUrl(source)) {
			assertSafeRemoteUrl(new URL(source));
			return source;
		}
		return path.resolve(process.cwd(), source);
	}

	throw new NoRegistrySourceError();
}

/**
 * Reject a Content-Length that is missing as a number, negative, or over the cap.
 * @param header - Raw Content-Length header, if any.
 * @param label - Error context label.
 * @throws Error when the header is present but invalid, or claims a body over the cap.
 */
function assertRemoteContentLength(header: string | null, label: string): void {
	if (header === null || header === "") return;
	const length = Number(header);
	if (!Number.isInteger(length) || length < 0)
		throw new Error(`Remote ${label} has an invalid Content-Length.`);
	if (length > JSON_DOCUMENT_BYTE_LIMIT)
		throw new Error(`Remote ${label} is too large.`);
}

/**
 * Read a fetch body, aborting once it exceeds the JSON size cap.
 * @param response - HTTP response whose body to consume.
 * @param label - Error context label.
 * @returns Body bytes at or under the cap.
 * @throws Error when the body is missing or larger than the cap.
 */
async function readCappedResponseBytes(
	response: Response,
	label: string,
): Promise<Buffer> {
	if (!response.body)
		throw new Error(`Remote ${label} returned an empty body.`);

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > JSON_DOCUMENT_BYTE_LIMIT) {
			await reader.cancel();
			throw new Error(`Remote ${label} is too large.`);
		}
		chunks.push(value);
	}

	return Buffer.concat(chunks, total);
}

/**
 * Fetch a remote JSON document over HTTPS.
 *
 * Runs {@link assertSafeRemoteUrl} before the request, rejects redirects so a
 * public URL cannot bounce to another host, and caps response size and duration.
 *
 * @param url - Absolute HTTPS URL.
 * @param label - Error context label for fetch failures.
 * @returns Response body bytes.
 * @throws Error when the URL fails remote registry policy, the request fails, or the response is too large.
 */
async function fetchRemoteJsonBytes(
	url: string,
	label: string,
): Promise<Buffer> {
	const parsedUrl = new URL(url);
	assertSafeRemoteUrl(parsedUrl);

	const fetchTimeoutMs = 10_000;

	let response: Response;
	try {
		response = await fetch(parsedUrl, {
			method: "GET",
			redirect: "error",
			signal: AbortSignal.timeout(fetchTimeoutMs),
			headers: { accept: "application/json" },
		});
	} catch (error) {
		if (
			error instanceof Error &&
			(error.name === "TimeoutError" || error.name === "AbortError")
		)
			throw new Error(
				`Timed out fetching ${label} from ${url} after ${Math.floor(fetchTimeoutMs / 1000)}s.`,
				{ cause: error },
			);

		// fetch throws TypeError on redirect when redirect: "error".
		if (error instanceof TypeError && /redirect/i.test(error.message))
			throw new Error("Remote registries must not redirect.", {
				cause: error,
			});

		throw new Error(`Failed to fetch ${label} from ${url}.`, { cause: error });
	}

	if (!response.ok)
		throw new Error(
			`Failed to fetch ${label} (${response.status} ${response.statusText}).`,
		);

	assertRemoteContentLength(response.headers.get("content-length"), label);
	return readCappedResponseBytes(response, label);
}

/**
 * Parse UTF-8 JSON bytes with a labeled error.
 * @param bytes - Document bytes.
 * @param label - Error context label.
 * @param location - Absolute path or HTTPS URL the bytes came from; a URL implies remote handling.
 * @returns Parsed JSON value.
 * @throws Error when the bytes are not valid JSON.
 */
function parseJsonDocumentBytes(
	bytes: Buffer,
	label: string,
	location: string,
): unknown {
	const remote = isAbsoluteHttpUrl(location);
	try {
		return JSON.parse(bytes.toString("utf8")) as unknown;
	} catch (error) {
		if (!remote && error instanceof SyntaxError)
			throw new InvalidJsonError(`${label} at ${location}`, error);
		const message = error instanceof Error ? error.message : String(error);
		if (remote)
			throw new Error(`Remote ${label} returned invalid JSON: ${message}`);
		throw new Error(`Failed to read ${label} at ${location}: ${message}`, {
			cause: error,
		});
	}
}

/**
 * Load a JSON document's raw bytes (remote stream is capped; local files use utf8 read).
 * @param location - Absolute path or HTTPS URL.
 * @param label - Error context label.
 * @returns Raw bytes.
 * @throws Error when the fetch fails or the document exceeds the size cap.
 */
async function loadDocumentBytes(
	location: string,
	label: string,
): Promise<Buffer> {
	if (isAbsoluteHttpUrl(location)) return fetchRemoteJsonBytes(location, label);

	let text: string;
	try {
		text = await readFileAsync(location);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read ${label} at ${location}: ${message}`, {
			cause: error,
		});
	}

	const bytes = Buffer.from(text);
	if (bytes.length > JSON_DOCUMENT_BYTE_LIMIT)
		throw new Error(`${label} at ${location} is too large.`);
	return bytes;
}

/**
 * Load the registry selected by CLI flags, env, or saved config.
 * @param registryOverride - Optional `--registry` flag value.
 * @param savedRegistry - Optional registry source persisted via `cheetos configure set`.
 * @returns Parsed registry and the index path or URL it was loaded from.
 * @throws Error when the located registry cannot be loaded safely.
 */
export async function loadRuntimeRegistry(
	registryOverride?: string,
	savedRegistry?: string,
): Promise<LoadedRegistry> {
	const indexLocation = await locateRegistry({
		registry: registryOverride,
		savedRegistry,
	});
	const bytes = await loadDocumentBytes(indexLocation, "registry");
	const value = parseJsonDocumentBytes(bytes, "registry", indexLocation);

	return {
		registry: parseRegistryDocument(value),
		indexLocation,
	};
}

/**
 * Load unique compiled items relative to a index location.
 * @param indexLocation - Absolute path or HTTPS URL of the index document.
 * @param sources - Catalog `source` URIs from the install plan.
 * @param itemIntegrity - sha256 digests keyed by catalog source URI.
 * @returns Map of catalog source URI to parsed compiled items.
 * @throws Error when a digest is missing or mismatched, JSON is invalid, or the document is not a compiled item.
 */
export async function loadCompiledItems(
	indexLocation: string,
	sources: readonly string[],
	itemIntegrity?: Record<string, string>,
): Promise<Map<string, CompiledItem>> {
	const uniqueSources = [...new Set(sources)];
	const documents = new Map<string, CompiledItem>();

	await Promise.all(
		uniqueSources.map(async (source) => {
			const location = joinIndexSource(indexLocation, source);
			const bytes = await loadDocumentBytes(location, "compiled item");
			verifyItemIntegrity(itemIntegrity, source, bytes);
			const value = parseJsonDocumentBytes(bytes, "compiled item", location);
			documents.set(
				source,
				parseWithSchema(compiledItemSchema, value, `Compiled item "${source}"`),
			);
		}),
	);

	return documents;
}
