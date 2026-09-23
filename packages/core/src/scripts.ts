import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { unwrapModuleExport } from "./cjs-export";
import type { IndexItem, Registry } from "./schema";
import { assertSinglePathSegment, isAbsoluteHttpUrl } from "./urls";

/** How much the CLI trusts a registry index location for script execution. */
export enum RegistryTrust {
	/** Packaged default registry shipped with the CLI. */
	BUNDLED = "bundled",
	/** Local filesystem registry that is not the bundled default. */
	LOCAL = "local",
	/** Remote HTTPS registry (scripts never execute). */
	REMOTE = "remote",
}

/** Catalog scripts that may run for a candidate install set, split by effect. */
export interface DeclaredScriptUris {
	/** Condition handlers used only to infer prompt defaults. */
	infer: string[];
	/** beforeWrite and afterInstall hooks that may execute. */
	mutation: string[];
}

/** Whether catalog scripts may load after trust checks. */
export interface ScriptExecutionPolicy {
	/** Condition infer handlers may load. */
	allowInfer: boolean;
	/** beforeWrite and afterInstall hooks may load. */
	allowMutation: boolean;
}

/** Prefix used for Subresource Integrity-style sha256 digests. */
export const INTEGRITY_PREFIX = "sha256-";

/**
 * Deduplicate and sort strings without loading package/schema dependencies.
 * The sandbox child imports this module under a restricted filesystem.
 * @param values - Values that may contain duplicates.
 * @returns Sorted unique copy.
 */
function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Compute an SRI-style sha256 digest for raw bytes.
 * @param bytes - Content to hash.
 * @returns Digest as `sha256-<base64>`.
 */
export function sha256Integrity(bytes: Buffer | string): string {
	const digest = createHash("sha256")
		.update(typeof bytes === "string" ? Buffer.from(bytes) : bytes)
		.digest("base64");
	return `${INTEGRITY_PREFIX}${digest}`;
}

/**
 * Verify bytes against an expected integrity digest.
 * @param bytes - Content that was read.
 * @param expected - Expected `sha256-<base64>` value.
 * @param label - Noun used in error messages (e.g. script URI).
 * @throws Error when the digest is missing, malformed, or does not match.
 */
export function assertIntegrityMatch(
	bytes: Buffer | string,
	expected: string | undefined,
	label: string,
): void {
	if (expected === undefined || expected.trim() === "")
		throw new Error(
			`Missing integrity digest for ${label}. Rebuild the registry or refuse untrusted content.`,
		);
	if (!expected.startsWith(INTEGRITY_PREFIX))
		throw new Error(
			`Invalid integrity digest for ${label}: expected ${INTEGRITY_PREFIX}<base64>.`,
		);
	const actual = sha256Integrity(bytes);
	if (actual !== expected)
		throw new Error(
			`Integrity check failed for ${label}: content does not match the registry digest.`,
		);
}

/**
 * Classify how much the CLI should trust a registry index location.
 * @param indexLocation - Absolute path or HTTPS URL of registry.json.
 * @returns Trust classification for script policy decisions.
 */
export function classifyRegistryTrust(indexLocation: string): RegistryTrust {
	if (isAbsoluteHttpUrl(indexLocation)) return RegistryTrust.REMOTE;
	if (!path.isAbsolute(indexLocation))
		throw new Error(
			"Registry index location must be an absolute path or HTTPS URL.",
		);
	return RegistryTrust.LOCAL;
}

/**
 * Decide whether scripts may run for this registry.
 * Local and bundled registries run scripts in the sandbox; remote HTTPS registries
 * refuse mutation hooks and skip infer handlers.
 * @param trust - Registry trust classification.
 * @param scripts - Infer and mutation URIs that would run for this install.
 * @returns Which script kinds may load.
 * @throws Error when mutation hooks are required from a remote registry.
 */
export async function assertScriptsAllowed(
	trust: RegistryTrust,
	scripts: DeclaredScriptUris,
): Promise<ScriptExecutionPolicy> {
	switch (trust) {
		case RegistryTrust.REMOTE:
			// Infer handlers are skipped on remote registries; mutation hooks are refused.
			if (scripts.mutation.length > 0)
				throw new Error(
					"Registry scripts require a local registry. Remote HTTPS registries cannot execute custom scripts.",
				);
			return { allowInfer: false, allowMutation: false };
		case RegistryTrust.BUNDLED:
		case RegistryTrust.LOCAL:
			return {
				allowInfer: scripts.infer.length > 0,
				allowMutation: scripts.mutation.length > 0,
			};
		/* v8 ignore next 4 — exhaustive check for future RegistryTrust members */
		default: {
			const exhaustive: never = trust;
			throw new Error(`Unhandled registry trust: ${String(exhaustive)}`);
		}
	}
}

/**
 * Read an own integrity digest, ignoring Object.prototype.
 * @param integrityMap - Optional digest map from the registry document.
 * @param key - Script URI or item source URI.
 * @returns The own digest, or undefined when the key is missing.
 */
function ownIntegrityDigest(
	integrityMap: Record<string, string> | undefined,
	key: string,
): string | undefined {
	return integrityMap !== undefined && Object.hasOwn(integrityMap, key)
		? integrityMap[key]
		: undefined;
}

/**
 * Look up and verify a script integrity digest from the registry index map.
 * @param integrityMap - Optional `scriptIntegrity` map from the registry document.
 * @param scriptUri - Catalog script URI.
 * @param bytes - Script file bytes.
 * @throws Error when the digest is missing or mismatched.
 */
export function verifyScriptIntegrity(
	integrityMap: Record<string, string> | undefined,
	scriptUri: string,
	bytes: Buffer | string,
): void {
	assertIntegrityMatch(
		bytes,
		ownIntegrityDigest(integrityMap, scriptUri),
		`script ${scriptUri}`,
	);
}

/**
 * Look up and verify a compiled item integrity digest from the registry index map.
 * @param integrityMap - Optional `itemIntegrity` map from the registry document.
 * @param sourceUri - Catalog item `source` URI.
 * @param bytes - Compiled item JSON bytes.
 * @throws Error when the digest is missing or mismatched.
 */
export function verifyItemIntegrity(
	integrityMap: Record<string, string> | undefined,
	sourceUri: string,
	bytes: Buffer | string,
): void {
	assertIntegrityMatch(
		bytes,
		ownIntegrityDigest(integrityMap, sourceUri),
		`item ${sourceUri}`,
	);
}

/** Loads and invokes a compiled registry script module. */
export interface ScriptExecutor {
	/**
	 * Load a script module export and validate its shape.
	 * @param indexLocation - Absolute path to registry.json (must be local).
	 * @param scriptUri - Catalog script URI.
	 * @param isValid - Predicate that accepts a usable export.
	 * @param errorMessage - Error when the export shape is invalid.
	 * @returns Loaded export (default export or module itself).
	 */
	loadModule: <T>(
		indexLocation: string,
		scriptUri: string,
		isValid: (value: unknown) => value is T,
		errorMessage: string,
	) => Promise<T>;
}

/** Options for constructing a script executor. */
export interface CreateScriptExecutorOptions {
	/**
	 * Locate a catalog script URI to an absolute local path.
	 * @param indexLocation - Absolute path to registry.json.
	 * @param scriptUri - Catalog script URI.
	 */
	locateScriptPath: (indexLocation: string, scriptUri: string) => string;
	/**
	 * Integrity map from the registry document.
	 * A missing map or digest is a missing digest (fail closed).
	 */
	scriptIntegrity?: Record<string, string>;
	/**
	 * Execution backend. Defaults to in-process `require` until the sandboxed
	 * child executor is selected by callers.
	 */
	mode?: "in-process" | "sandbox";
	/** Absolute path to the project receiving the install (sandbox mode). */
	projectDir?: string;
	/** Absolute path to the sandbox runner entry (sandbox mode). */
	runnerPath?: string;
}

/**
 * Create a script executor that verifies integrity before load.
 * @param options - Path locator, integrity map, and execution mode.
 * @returns Script executor.
 * @throws Error when sandbox mode is requested without required paths.
 */
export function createScriptExecutor(
	options: CreateScriptExecutorOptions,
): ScriptExecutor {
	const mode = options.mode ?? "in-process";
	if (mode === "sandbox") return createSandboxedScriptExecutor(options);
	return createInProcessScriptExecutor(options);
}

/**
 * Executor that refuses every script load (CLI fail-closed when scripts are not allowed).
 * @returns Script executor that always throws.
 */
export function createRejectedScriptExecutor(): ScriptExecutor {
	return {
		async loadModule<T>(
			_indexLocation: string,
			scriptUri: string,
			_isValid: (value: unknown) => value is T,
			_errorMessage: string,
		): Promise<T> {
			throw new Error(
				`Registry script "${scriptUri}" cannot run: scripts are not allowed for this install.`,
			);
		},
	};
}

/**
 * Locate a script path and verify its digest before load.
 * @param options - Path locator and integrity map.
 * @param indexLocation - Absolute path to registry.json.
 * @param scriptUri - Catalog script URI.
 * @returns Absolute filesystem path of the script.
 * @throws Error when the digest is missing or mismatched.
 */
function verifiedScriptPath(
	options: CreateScriptExecutorOptions,
	indexLocation: string,
	scriptUri: string,
): string {
	const absolutePath = options.locateScriptPath(indexLocation, scriptUri);
	if (!path.isAbsolute(absolutePath))
		throw new Error(`Script path for "${scriptUri}" must be an absolute path.`);
	verifyScriptIntegrity(
		options.scriptIntegrity,
		scriptUri,
		fs.readFileSync(absolutePath),
	);
	return absolutePath;
}

/**
 * Locate, verify integrity, unwrap, and validate an exported script module.
 * @param options - Path locator and integrity map options.
 * @param indexLocation - Absolute path to registry.json.
 * @param scriptUri - Catalog script URI.
 * @param isValid - Predicate that accepts a usable export.
 * @param errorMessage - Error message thrown when the export shape is invalid.
 * @param invoke - Async callback that loads or sandboxes the verified module file.
 * @returns Validated script export.
 * @throws Error when the digest is mismatched or the export fails validation.
 */
async function executeModuleLoader<T>(
	options: CreateScriptExecutorOptions,
	indexLocation: string,
	scriptUri: string,
	isValid: (value: unknown) => value is T,
	errorMessage: string,
	invoke: (absolutePath: string) => Promise<unknown>,
): Promise<T> {
	const absolutePath = verifiedScriptPath(options, indexLocation, scriptUri);
	const script = unwrapModuleExport(await invoke(absolutePath));
	if (!isValid(script)) throw new Error(errorMessage);
	return script;
}

/**
 * In-process `require` executor (used for tests and as the pre-sandbox path).
 * @param options - Path locator and integrity map.
 * @returns Script executor.
 */
function createInProcessScriptExecutor(
	options: CreateScriptExecutorOptions,
): ScriptExecutor {
	const requireScript = createRequire(__filename);
	return {
		async loadModule<T>(
			indexLocation: string,
			scriptUri: string,
			isValid: (value: unknown) => value is T,
			errorMessage: string,
		): Promise<T> {
			return executeModuleLoader(
				options,
				indexLocation,
				scriptUri,
				isValid,
				errorMessage,
				async (absolutePath) => {
					Reflect.deleteProperty(requireScript.cache, absolutePath);
					return requireScript(absolutePath);
				},
			);
		},
	};
}

/**
 * Sandboxed executor that loads modules in a permissioned child process.
 * @param options - Sandbox executor options.
 * @returns Script executor that loads modules in a permissioned child process.
 */
function createSandboxedScriptExecutor(
	options: CreateScriptExecutorOptions,
): ScriptExecutor {
	const projectDir = options.projectDir;
	const runnerPath = options.runnerPath;
	if (!projectDir || !runnerPath)
		throw new Error(
			"Sandbox script execution requires projectDir and runnerPath.",
		);
	if (!path.isAbsolute(projectDir))
		throw new Error("Project directory must be an absolute path.");
	if (!path.isAbsolute(runnerPath))
		throw new Error("Sandbox runner path must be an absolute path.");
	return {
		async loadModule<T>(
			indexLocation: string,
			scriptUri: string,
			isValid: (value: unknown) => value is T,
			errorMessage: string,
		): Promise<T> {
			return executeModuleLoader(
				options,
				indexLocation,
				scriptUri,
				isValid,
				errorMessage,
				(absolutePath) =>
					loadSandboxedModule(absolutePath, projectDir, runnerPath),
			);
		},
	};
}

/**
 * Collect catalog script URIs declared on an index item (local handlers + install hooks).
 * @param item - Compiled index item.
 * @returns Script URIs in declaration order (may contain duplicates).
 */
function collectItemScriptUris(item: IndexItem): string[] {
	return [
		...(item.beforeWrite ?? []),
		...(item.afterInstall ?? []),
		...Object.values(item.conditions ?? {})
			.map((condition) => condition.handler)
			.filter((uri): uri is string => uri !== undefined),
		...(item.packs ?? []).flatMap((pack) => [
			...(pack.beforeWrite ?? []),
			...(pack.afterInstall ?? []),
		]),
	];
}

/**
 * Collect compiled item `source` URIs for an index item and its packs.
 * @param item - Compiled index item.
 * @returns Item payload URIs in declaration order.
 */
function collectItemSourceUris(item: IndexItem): string[] {
	const uris: string[] = [];
	if (item.source) uris.push(item.source);
	for (const pack of item.packs ?? []) {
		if (pack.source) uris.push(pack.source);
	}
	return uris;
}

/**
 * Collect every compiled script and item URI from a registry index.
 * @param registry - Parsed registry document.
 * @returns Deduplicated, sorted catalog URIs.
 */
export function collectRegistryArtifactUris(registry: Registry): {
	scriptUris: string[];
	itemUris: string[];
} {
	const scriptUris: string[] = [];
	const itemUris: string[] = [];

	for (const handler of Object.values(registry.conditions ?? {})
		.map((condition) => condition.handler)
		.filter((uri): uri is string => uri !== undefined)) {
		scriptUris.push(handler);
	}

	for (const item of Object.values(registry.items)) {
		scriptUris.push(...collectItemScriptUris(item));
		itemUris.push(...collectItemSourceUris(item));
	}

	return {
		scriptUris: uniqueSorted(scriptUris),
		itemUris: uniqueSorted(itemUris),
	};
}

/** Maximum time a sandboxed script may run before the child is killed. */
const SCRIPT_TIMEOUT_MS = 60_000;

type ScriptExportShape = "function" | "condition-handler" | "unknown";
type HostMethod = "isFile" | "isDirectory" | "readFile" | "run";

/** IPC request from the sandboxed child to the parent. */
type ChildRequest =
	| {
			type: "probe-result";
			shape: ScriptExportShape;
	  }
	| {
			type: "host";
			id: number;
			method: HostMethod;
			args: string[];
	  }
	| {
			type: "result";
			ok: true;
			value: unknown;
	  }
	| {
			type: "result";
			ok: false;
			error: string;
	  };

/** IPC command from the parent to the sandboxed child. */
type ParentCommand =
	| { type: "probe"; scriptPath: string }
	| {
			type: "call";
			scriptPath: string;
			exportPath: string[];
			context: SerializedHandlerContext;
	  }
	| {
			type: "host-result";
			id: number;
			ok: true;
			value: unknown;
	  }
	| {
			type: "host-result";
			id: number;
			ok: false;
			error: string;
	  };

/** JSON-serializable install/condition context (functions restored via IPC). */
interface SerializedHandlerContext {
	projectDir: string;
	[key: string]: unknown;
}

/**
 * Check whether a value is a non-array object suitable for record access.
 * @param value - Value received across the IPC boundary.
 * @returns True when the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check whether a value is an array of strings.
 * @param value - Value received across the IPC boundary.
 * @returns True when every array entry is a string.
 */
function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((entry) => typeof entry === "string")
	);
}

/**
 * Check whether a value is one of the supported host helper method names.
 * @param value - Candidate method name.
 * @returns True when value is isFile, isDirectory, readFile, or run.
 */
function isHostMethod(value: unknown): value is HostMethod {
	return (
		value === "isFile" ||
		value === "isDirectory" ||
		value === "readFile" ||
		value === "run"
	);
}

/**
 * Check whether a value matches a script probe result shape.
 * @param value - Candidate script export shape name.
 * @returns True when value is function, condition-handler, or unknown.
 */
function isScriptExportShape(value: unknown): value is ScriptExportShape {
	return (
		value === "function" || value === "condition-handler" || value === "unknown"
	);
}

/**
 * Validate that a child message is a valid host helper execution request.
 * @param message - Candidate host request message.
 * @returns True when message has valid id, method, and string arguments.
 */
function isHostRequest(message: Record<string, unknown>): boolean {
	return (
		Number.isSafeInteger(message.id) &&
		isHostMethod(message.method) &&
		isStringArray(message.args)
	);
}

/**
 * Validate that a child message is a valid execution result response.
 * @param message - Candidate result message.
 * @returns True when ok is boolean and error is string on failure.
 */
function isResultRequest(message: Record<string, unknown>): boolean {
	return (
		message.ok === true ||
		(message.ok === false && typeof message.error === "string")
	);
}

/**
 * Validate a message sent from the sandbox child.
 * @param message - Unknown value received over IPC.
 * @returns True when the value matches the child-to-parent protocol.
 */
function isChildRequest(message: unknown): message is ChildRequest {
	if (!isRecord(message) || typeof message.type !== "string") return false;

	switch (message.type) {
		case "probe-result":
			return isScriptExportShape(message.shape);
		case "host":
			return isHostRequest(message);
		case "result":
			return isResultRequest(message);
		default:
			return false;
	}
}

/**
 * Validate that a parent command payload is a valid function invocation request.
 * @param message - Candidate call command.
 * @returns True when scriptPath, exportPath, and context are properly shaped.
 */
/* v8 ignore next 8 — exercised only in the sandboxed child process */
function isCallCommand(message: Record<string, unknown>): boolean {
	return (
		typeof message.scriptPath === "string" &&
		isStringArray(message.exportPath) &&
		isRecord(message.context) &&
		typeof message.context.projectDir === "string"
	);
}

/**
 * Validate that a parent command payload is a valid host helper result.
 * @param message - Candidate host-result command.
 * @returns True when id and result status/payload match protocol expectations.
 */
/* v8 ignore next 7 — exercised only in the sandboxed child process */
function isHostResultCommand(message: Record<string, unknown>): boolean {
	return (
		Number.isSafeInteger(message.id) &&
		(message.ok === true ||
			(message.ok === false && typeof message.error === "string"))
	);
}

/**
 * Validate a message sent from the parent process.
 * @param message - Unknown value received over IPC.
 * @returns True when the value matches the parent-to-child protocol.
 */
/* v8 ignore next 14 — exercised only in the sandboxed child process */
function isParentCommand(message: unknown): message is ParentCommand {
	if (!isRecord(message) || typeof message.type !== "string") return false;

	switch (message.type) {
		case "probe":
			return typeof message.scriptPath === "string";
		case "call":
			return isCallCommand(message);
		case "host-result":
			return isHostResultCommand(message);
		default:
			return false;
	}
}

/**
 * Environment variables safe to expose to `ctx.run` in the parent.
 * Omits cloud tokens and generic `*KEY*` / `*TOKEN*` / `*SECRET*` secrets.
 */
function sanitizedRunEnv(): NodeJS.ProcessEnv {
	const allow = new Set([
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"TERM",
		"TMPDIR",
		"TMP",
		"TEMP",
		"SHELL",
		"GIT_AUTHOR_NAME",
		"GIT_AUTHOR_EMAIL",
		"GIT_COMMITTER_NAME",
		"GIT_COMMITTER_EMAIL",
		"GIT_TERMINAL_PROMPT",
	]);
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		/* v8 ignore next — process.env values are strings when present */
		if (value === undefined) continue;
		if (allow.has(key) || key.startsWith("GIT_CONFIG_")) env[key] = value;
	}
	return env;
}

/**
 * Resolve a path for Node's permission allow-list.
 * Uses realpath so macOS `/var` → `/private/var` symlinks do not break reads.
 * @param absolutePath - Absolute filesystem path.
 * @returns Canonical absolute path when available.
 */
function permissionPath(absolutePath: string): string {
	/* v8 ignore start — callers pass absolute paths; realpath may miss temp dirs */
	if (!path.isAbsolute(absolutePath))
		throw new Error("Sandbox permission path must be an absolute path.");
	try {
		return fs.realpathSync(absolutePath);
	} catch {
		return path.resolve(absolutePath);
	}
	/* v8 ignore stop */
}

/**
 * Build Node permission flags for the sandboxed child.
 * @param scriptPath - Absolute path to the script file to execute.
 * @param runnerPath - Absolute path to this runner module.
 * @param projectDir - Absolute project root (read-only for the child).
 * @param sandboxTempDir - Private temporary directory available to the child.
 * @returns CLI args enabling the permission model with minimal read access.
 */
function permissionArgs(
	scriptPath: string,
	runnerPath: string,
	projectDir: string,
	sandboxTempDir: string,
): string[] {
	/* v8 ignore next 3 — Node major / legacy permission flag branches */
	const major = Number(process.versions.node.split(".")[0] ?? "0");
	const permissionFlag =
		major >= 22 ? "--permission" : "--experimental-permission";
	const allowed = new Set([
		permissionPath(runnerPath),
		permissionPath(path.dirname(runnerPath)),
		permissionPath(scriptPath),
		permissionPath(path.dirname(scriptPath)),
		permissionPath(projectDir),
		permissionPath(sandboxTempDir),
	]);
	const args = [
		permissionFlag,
		...[...allowed].map((entry) => `--allow-fs-read=${entry}`),
		`--allow-fs-write=${permissionPath(sandboxTempDir)}`,
	];
	// Node 20 cannot deny network via the permission model; stripped env still
	// reduces credential exfiltration. Node 22+ omits --allow-net by default.
	return args;
}

/**
 * Serialize a handler context by dropping function fields.
 * @param ctx - Live handler context.
 * @returns JSON-safe context payload.
 */
function serializeContext(
	ctx: Record<string, unknown>,
): SerializedHandlerContext {
	const serialized: SerializedHandlerContext = {
		projectDir: String(ctx.projectDir),
	};
	for (const [key, value] of Object.entries(ctx)) {
		if (typeof value === "function") continue;
		if (key === "projectDir") continue;
		if (key.length === 0 || key === "__proto__")
			throw new Error(`Handler context key "${key}" is not allowed.`);
		serialized[key] = value;
	}
	return serialized;
}

/**
 * Load a registry script inside a permissioned child process and return a
 * callable proxy matching the export shape (`function` or `{ infer }`).
 * @param scriptPath - Absolute path to the compiled script.
 * @param projectDir - Absolute project root for confined host helpers.
 * @param runnerPath - Absolute path to the sandbox runner entry module.
 * @returns Proxy export that forwards invocations to the child over IPC.
 */
export async function loadSandboxedModule(
	scriptPath: string,
	projectDir: string,
	runnerPath: string,
): Promise<unknown> {
	const resolvedScriptPath = permissionPath(scriptPath);
	const resolvedProjectDir = permissionPath(projectDir);
	const resolvedRunnerPath = permissionPath(runnerPath);

	const shape = await withSandboxChild(
		resolvedScriptPath,
		resolvedProjectDir,
		resolvedRunnerPath,
		async (send, waitFor) => {
			send({ type: "probe", scriptPath: resolvedScriptPath });
			const message = await waitFor(
				(
					msg,
				): msg is
					| Extract<ChildRequest, { type: "probe-result" }>
					| Extract<ChildRequest, { type: "result"; ok: false }> =>
					msg.type === "probe-result" ||
					(msg.type === "result" && msg.ok === false),
			);
			/* v8 ignore start — probe failures surface as result ok:false */
			if (message.type === "result") throw new Error(message.error);
			/* v8 ignore stop */
			return message.shape;
		},
	);

	const callExport = async (
		exportPath: string[],
		ctx: Record<string, unknown>,
	): Promise<unknown> =>
		withSandboxChild(
			resolvedScriptPath,
			resolvedProjectDir,
			resolvedRunnerPath,
			async (send, waitFor) => {
				send({
					type: "call",
					scriptPath: resolvedScriptPath,
					exportPath,
					context: serializeContext({
						...ctx,
						projectDir: resolvedProjectDir,
					}),
				});

				for (;;) {
					const message = await waitFor(
						(msg: ChildRequest): msg is ChildRequest => true,
					);
					if (message.type === "host") {
						try {
							const value = await invokeHostMethod(
								resolvedProjectDir,
								message.method,
								message.args,
							);
							send({ type: "host-result", id: message.id, ok: true, value });
						} catch (error) {
							/* v8 ignore next 7 — host helpers throw Error instances */
							send({
								type: "host-result",
								id: message.id,
								ok: false,
								error: error instanceof Error ? error.message : String(error),
							});
						}
						continue;
					}
					if (message.type === "result") {
						if (!message.ok) throw new Error(message.error);
						return message.value;
					}
				}
			},
		);

	if (shape === "condition-handler") {
		return {
			infer: async (ctx: Record<string, unknown>) => callExport(["infer"], ctx),
		};
	}

	if (shape === "function") {
		return async (ctx: Record<string, unknown>) => callExport([], ctx);
	}

	throw new Error(
		`Sandboxed script "${scriptPath}" must export a function or a condition handler with infer.`,
	);
}

/**
 * Read the non-empty string argument for a parent-mediated host helper.
 * @param args - IPC argument list from the child.
 * @param method - Host method name for error messages.
 * @returns First argument.
 * @throws Error when the argument is missing or not a non-empty string.
 */
function hostMethodArgument(args: unknown, method: HostMethod): string {
	/* v8 ignore start — child hostCall always sends a non-empty string argument */
	if (
		!Array.isArray(args) ||
		typeof args[0] !== "string" ||
		args[0].length === 0
	)
		throw new Error(
			`Host method "${method}" requires a non-empty string argument.`,
		);
	/* v8 ignore stop */
	return args[0];
}

/**
 * Invoke a parent-mediated host helper for the sandboxed script.
 * @param projectDir - Absolute project root.
 * @param method - Host method name.
 * @param args - Positional arguments from IPC.
 * @returns Host method result.
 */
async function invokeHostMethod(
	projectDir: string,
	method: HostMethod,
	args: unknown,
): Promise<unknown> {
	const argument = hostMethodArgument(args, method);

	// Keep host dependencies lazy: the sandbox child cannot read package dependencies before IPC mediation.
	const { createHandlerRuntime } = await import("./handlers");
	const { isFileAsync, isDirectoryAsync, readFileAsync } = await import("./fs");
	const { runAsync } = await import("./shell");

	const runtime = createHandlerRuntime(projectDir, {
		isFile: isFileAsync,
		isDirectory: isDirectoryAsync,
		readFile: readFileAsync,
		run: (command) =>
			runAsync(command, {
				cwd: projectDir,
				stdio: "pipe",
				env: sanitizedRunEnv(),
			}),
	});

	switch (method) {
		case "isFile":
			return runtime.isFile(argument);
		case "isDirectory":
			return runtime.isDirectory(argument);
		case "readFile":
			return runtime.readFile(argument);
		case "run": {
			console.error(`[yoinker:script] run: ${argument}`);
			return runtime.run(argument);
		}
		/* v8 ignore next 4 — exhaustive check for future HostMethod members */
		default: {
			const exhaustive: never = method;
			throw new Error(`Unhandled host method: ${String(exhaustive)}`);
		}
	}
}

/**
 * Spawn a permissioned child, run an IPC session, then tear the child down.
 * @param scriptPath - Absolute script path (for permission allow-lists).
 * @param projectDir - Absolute project root.
 * @param runnerPath - Absolute runner module path.
 * @param session - IPC session callback.
 * @returns Session result.
 */
async function withSandboxChild<T>(
	scriptPath: string,
	projectDir: string,
	runnerPath: string,
	session: (
		send: (message: ParentCommand) => void,
		waitFor: <M extends ChildRequest>(
			predicate: (message: ChildRequest) => message is M,
		) => Promise<M>,
	) => Promise<T>,
): Promise<T> {
	const sandboxTempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "yoinker-sandbox-"),
	);
	const child = spawn(
		process.execPath,
		[
			...permissionArgs(scriptPath, runnerPath, projectDir, sandboxTempDir),
			runnerPath,
			"--child",
		],
		{
			stdio: ["ignore", "inherit", "inherit", "ipc"],
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				LANG: process.env.LANG,
				TMPDIR: sandboxTempDir,
			},
		},
	);

	const queue: ChildRequest[] = [];
	const waiters: Array<{
		predicate: (message: ChildRequest) => boolean;
		resolve: (message: ChildRequest) => void;
		reject: (error: Error) => void;
	}> = [];

	let childFailure: Error | undefined;
	const failChild = (error: Error): void => {
		childFailure ??= error;
		for (const waiter of waiters.splice(0)) waiter.reject(childFailure);
	};

	const onMessage = (message: unknown) => {
		if (!isChildRequest(message)) {
			failChild(
				new Error("Sandboxed script child sent an invalid IPC message."),
			);
			return;
		}
		const typed = message;
		const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(typed));
		if (waiterIndex >= 0) {
			const [waiter] = waiters.splice(waiterIndex, 1);
			waiter.resolve(typed);
			return;
		}
		/* v8 ignore next — message arrived before a waiter registered */
		queue.push(typed);
	};

	child.on("message", onMessage);
	/* v8 ignore next 16 — spawn error / unexpected-exit status variants */
	child.on("error", (error) =>
		failChild(
			new Error(`Sandboxed script child failed: ${error.message}`, {
				cause: error,
			}),
		),
	);
	child.on("exit", (code, signal) => {
		let status: string;
		if (signal) status = `signal ${signal}`;
		else if (code === null) status = "without an exit code";
		else status = `exit ${code}`;
		failChild(
			new Error(`Sandboxed script child exited unexpectedly (${status}).`),
		);
	});

	/* v8 ignore next 3 — 60s watchdog; not exercised in unit tests */
	const timeout = setTimeout(() => {
		child.kill("SIGKILL");
	}, SCRIPT_TIMEOUT_MS);

	try {
		const send = (message: ParentCommand) => {
			/* v8 ignore next 2 — disconnect races during teardown */
			if (!child.connected)
				throw new Error("Sandboxed script child is not connected.");
			child.send(message);
		};

		const waitFor = <M extends ChildRequest>(
			predicate: (message: ChildRequest) => message is M,
		): Promise<M> => {
			const queuedIndex = queue.findIndex((message) => predicate(message));
			/* v8 ignore next 5 — message arrived before the waiter registered */
			if (queuedIndex >= 0) {
				const [message] = queue.splice(queuedIndex, 1);
				return Promise.resolve(message as M);
			}
			if (childFailure) return Promise.reject(childFailure);
			return new Promise<M>((resolve, reject) => {
				waiters.push({
					predicate: predicate as (message: ChildRequest) => boolean,
					resolve: (message) => resolve(message as M),
					reject,
				});
			});
		};

		return await session(send, waitFor);
	} finally {
		clearTimeout(timeout);
		child.off("message", onMessage);
		await closeChild(child);
		await fs.promises.rm(sandboxTempDir, { recursive: true, force: true });
	}
}

/**
 * Kill and wait for a child process to exit.
 * @param child - Child process to close.
 */
async function closeChild(child: ChildProcess): Promise<void> {
	if (!child.killed) child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		child.once("exit", () => resolve());
	});
}

/* v8 ignore start — child IPC runs in a spawned process loading dist/scripts.js */
/**
 * Wire parent IPC so the child can wait for commands and call host helpers.
 * @param send - Send a message to the parent.
 * @returns Command waiter and a context factory with IPC-backed helpers.
 */
function installChildIpc(send: (message: ChildRequest) => void): {
	waitForCommand: () => Promise<ParentCommand>;
	buildContext: (
		serialized: SerializedHandlerContext,
	) => SerializedHandlerContext & {
		isFile: (filePath: string) => Promise<boolean>;
		isDirectory: (filePath: string) => Promise<boolean>;
		readFile: (filePath: string) => Promise<string>;
		run: (command: string) => Promise<string>;
	};
} {
	let nextHostId = 1;
	const pendingHost = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	const pendingCommands: ParentCommand[] = [];
	const commandWaiters: Array<(command: ParentCommand) => void> = [];

	// Permanent listener: host-result must still arrive after the call command is received.
	process.on("message", (message: unknown) => {
		if (!isParentCommand(message)) {
			send({
				type: "result",
				ok: false,
				error: "Sandboxed script parent sent an invalid IPC command.",
			});
			return;
		}

		if (message.type === "host-result") {
			const pending = pendingHost.get(message.id);
			if (!pending) return;
			pendingHost.delete(message.id);
			if (message.ok) pending.resolve(message.value);
			else pending.reject(new Error(message.error));
			return;
		}

		const waiter = commandWaiters.shift();
		if (waiter) waiter(message);
		else pendingCommands.push(message);
	});

	const hostCall = async (
		method: HostMethod,
		args: string[],
	): Promise<unknown> => {
		const id = nextHostId++;
		const result = new Promise<unknown>((resolve, reject) => {
			pendingHost.set(id, { resolve, reject });
		});
		send({ type: "host", id, method, args });
		return result;
	};

	return {
		waitForCommand: () => {
			const queued = pendingCommands.shift();
			if (queued) return Promise.resolve(queued);
			return new Promise((resolve) => {
				commandWaiters.push(resolve);
			});
		},
		buildContext: (serialized) => ({
			...serialized,
			isFile: async (filePath: string) =>
				Boolean(await hostCall("isFile", [filePath])),
			isDirectory: async (filePath: string) =>
				Boolean(await hostCall("isDirectory", [filePath])),
			readFile: async (filePath: string) =>
				String(await hostCall("readFile", [filePath])),
			run: async (command: string) => String(await hostCall("run", [command])),
		}),
	};
}

/**
 * Classify a loaded script export for the parent probe handshake.
 * @param loaded - Unwrapped module export.
 * @returns Probe shape sent to the parent.
 */
function probeExportShape(loaded: unknown): ScriptExportShape {
	if (typeof loaded === "function") return "function";
	if (
		typeof loaded === "object" &&
		loaded !== null &&
		typeof (loaded as { infer?: unknown }).infer === "function"
	)
		return "condition-handler";
	return "unknown";
}

/**
 * Fail when an IPC export path segment is empty or `__proto__`.
 * @param segment - Candidate property name.
 * @throws Error when the segment is not a safe string key.
 */
function assertExportPathSegment(segment: unknown): asserts segment is string {
	if (typeof segment !== "string")
		throw new Error(`Cannot resolve export path "${String(segment)}".`);
	assertSinglePathSegment("Export path segment", segment);
}

/**
 * Resolve and invoke a sandboxed export path with the restored context.
 * @param loaded - Unwrapped module export.
 * @param exportPath - Property path from the module root (`[]` = default function).
 * @param context - Context object passed to the export.
 * @returns Export return value.
 */
async function invokeSandboxedExport(
	loaded: unknown,
	exportPath: unknown,
	context: Record<string, unknown>,
): Promise<unknown> {
	if (!Array.isArray(exportPath))
		throw new Error("Sandboxed export path did not resolve to a function.");
	let target: unknown = loaded;
	for (const segment of exportPath) {
		assertExportPathSegment(segment);
		if (typeof target !== "object" || target === null)
			throw new Error(`Cannot resolve export path "${segment}".`);
		target = (target as Record<string, unknown>)[segment];
	}
	if (typeof target !== "function")
		throw new Error("Sandboxed export path did not resolve to a function.");
	return target(context);
}

/**
 * Child-process entry: probe or invoke a script with IPC-backed `ctx` helpers.
 * Invoked when this module is executed with `--child`.
 */
async function runChild(): Promise<void> {
	const requireScript = createRequire(__filename);

	const send = (message: ChildRequest) => {
		if (!process.send) throw new Error("IPC channel is unavailable.");
		process.send(message);
	};
	const { waitForCommand, buildContext } = installChildIpc(send);
	const loadExport = (scriptPath: string): unknown => {
		Reflect.deleteProperty(requireScript.cache, scriptPath);
		return unwrapModuleExport(requireScript(scriptPath));
	};

	const command = await waitForCommand();
	try {
		if (command.type === "probe") {
			send({
				type: "probe-result",
				shape: probeExportShape(loadExport(command.scriptPath)),
			});
			return;
		}

		if (command.type === "call") {
			const value = await invokeSandboxedExport(
				loadExport(command.scriptPath),
				command.exportPath,
				buildContext(command.context),
			);
			send({ type: "result", ok: true, value });
		}
	} catch (error) {
		send({
			type: "result",
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

if (process.argv.includes("--child")) {
	runChild().catch((error: unknown) => {
		if (process.send)
			process.send({
				type: "result",
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			} satisfies ChildRequest);
		process.exitCode = 1;
	});
}

/* v8 ignore stop */

/**
 * Absolute on-disk path to this sandbox runner for child spawns.
 * @returns Absolute path to the compiled or source runner entry.
 */
export function sandboxRunnerPath(): string {
	// Prefer the compiled JS next to this module; fall back to this file under tsx/vitest.
	const compiled = path.join(__dirname, "scripts.js");
	if (fs.existsSync(compiled)) return permissionPath(compiled);
	return permissionPath(__filename);
}
