import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	isMissingPathError,
	lstatAsync,
	readFileAsync,
	removeAsync,
} from "@yoinker/core";

/** Maximum size of the global config file. */
const CONFIG_FILE_BYTE_LIMIT = 65_536;

/** Persisted yoinker CLI settings (`registry` = default URL or local path). */
export interface YoinkerConfig {
	registry?: string;
}

/**
 * Return the absolute path to the global yoinker config file.
 * @param env - Environment used for `XDG_CONFIG_HOME`. Defaults to `process.env`.
 * @returns Absolute config file path.
 */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	const xdg = env.XDG_CONFIG_HOME?.trim();

	// Honour XDG_CONFIG_HOME when set, otherwise use the home directory.
	const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), ".config");
	return path.join(base, "yoinker", "config.json");
}

/**
 * Narrow parsed JSON to the known yoinker config shape.
 * @param parsed - JSON value from the config file.
 * @returns Config with only known keys.
 * @throws Error when the root is not an object or a key is unknown.
 */
function yoinkerConfigFromJson(parsed: unknown): YoinkerConfig {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Config root must be a JSON object.");

	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "registry") throw new Error(`Unknown config key "${key}".`);
	}

	return validatedConfig(record);
}

/**
 * Validate a config value and return its canonical shape.
 * @param config - Config value with a possibly unvalidated `registry`.
 * @returns Config containing only the known `registry` key.
 * @throws Error when `registry` is present but not a non-empty string.
 */
function validatedConfig(config: { registry?: unknown }): YoinkerConfig {
	if (config.registry === undefined) return {};
	if (typeof config.registry !== "string" || !config.registry.trim())
		throw new Error('"registry" must be a non-empty string URL or file path.');
	return { registry: config.registry.trim() };
}

/**
 * Reject a config path that is a symlink, directory, or special node.
 * @param filePath - Absolute config.json path.
 * @param stat - lstat result for that path.
 * @param action - `"read"` or `"write"`, used in the error message.
 * @throws Error when the path is not a regular file.
 */
function assertConfigPathIsRegularFile(
	filePath: string,
	stat: fs.Stats,
	action: "read" | "write",
): void {
	if (stat.isSymbolicLink())
		throw new Error(
			`Cannot ${action} yoinker config at ${filePath}: file is a symbolic link.`,
		);
	if (stat.isDirectory())
		throw new Error(
			`Cannot ${action} yoinker config at ${filePath}: path is a directory.`,
		);
	if (!stat.isFile())
		throw new Error(
			`Cannot ${action} yoinker config at ${filePath}: path is neither a file nor a directory.`,
		);
}

/**
 * Assert the config path is a regular file small enough to parse, or missing.
 * @param filePath - Absolute config.json path.
 * @returns False when the file does not exist.
 * @throws Error when the path is a symlink, directory, special node, or too large.
 */
async function assertReadableConfigFile(filePath: string): Promise<boolean> {
	const stat = await lstatAsync(filePath);
	if (!stat) return false;
	assertConfigPathIsRegularFile(filePath, stat, "read");
	if (stat.size > CONFIG_FILE_BYTE_LIMIT)
		throw new Error(
			`Cannot read yoinker config at ${filePath}: file is too large.`,
		);
	return true;
}

/**
 * Read the global yoinker config.
 * @param env - Environment used for config path resolution. Defaults to `process.env`.
 * @returns Parsed config object.
 * @throws Error when the config file exists but cannot be parsed as JSON, contains unknown keys, is a symlink or directory, or is too large.
 */
export async function readConfig(
	env?: NodeJS.ProcessEnv,
): Promise<YoinkerConfig> {
	const filePath = configPath(env);
	if (!(await assertReadableConfigFile(filePath))) return {};

	let raw: string;
	try {
		raw = await readFileAsync(filePath);
	} catch (error) {
		// The file could vanish between the lstat above and this read; treat a vanished file the same as a missing one.
		if (isMissingPathError(error)) return {};
		throw error;
	}

	try {
		return yoinkerConfigFromJson(JSON.parse(raw) as unknown);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Malformed yoinker config at ${filePath}: ${message}. Fix or delete the file, then retry.`,
		);
	}
}

/**
 * Write the global yoinker config, creating parent directories as needed.
 * @param config - Config object to persist.
 * @param env - Environment used for config path resolution. Defaults to `process.env`.
 * @throws Error when `registry` is not a non-empty string, or the path is a symlink, directory, or special node.
 */
export async function writeConfig(
	config: YoinkerConfig,
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	const toWrite = validatedConfig(config);
	const filePath = configPath(env);
	await fs.promises.mkdir(path.dirname(filePath), {
		recursive: true,
		mode: 0o700,
	});
	const stat = await lstatAsync(filePath);
	if (stat) assertConfigPathIsRegularFile(filePath, stat, "write");

	await fs.promises.writeFile(
		filePath,
		`${JSON.stringify(toWrite, null, "\t")}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

/**
 * Remove the saved registry key from the global config.
 * @param env - Environment used for config path resolution. Defaults to `process.env`.
 * @returns True when a previously saved registry was cleared.
 */
export async function unsetRegistryConfig(
	env?: NodeJS.ProcessEnv,
): Promise<boolean> {
	const config = await readConfig(env);
	if (config.registry === undefined) return false;

	await removeAsync(configPath(env));
	return true;
}
