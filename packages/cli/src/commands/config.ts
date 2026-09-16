import fs from "node:fs";
import path from "node:path";
import {
	assertSafeRemoteUrl,
	isAbsoluteHttpUrl,
	isMissingPathError,
	publishedRegistryUrl,
	readJsonFileAsync,
} from "@cheetos/core";
import {
	configPath,
	readConfig,
	unsetRegistryConfig,
	writeConfig,
} from "../cli/config";
import { dimText, primaryText } from "../cli/labels";
import { textInput } from "../cli/prompts";

/**
 * Read a published CLI version from package.json for the default registry URL.
 * @param pkg - Parsed CLI package.json value.
 * @returns Trimmed version string safe to embed in {@link publishedRegistryUrl}.
 * @throws Error when `version` is missing, empty, or contains URL/path metacharacters.
 */
function cliPackageVersion(pkg: unknown): string {
	if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg))
		throw new Error("CLI package.json must be a JSON object.");

	const { version } = pkg as Record<string, unknown>;
	if (typeof version !== "string" || !version.trim())
		throw new Error("CLI package.json is missing a version.");

	const trimmed = version.trim();
	if (/[/\\?#@]/.test(trimmed) || trimmed.includes(".."))
		throw new Error("CLI package.json version is invalid.");
	return trimmed;
}

/**
 * Read the published default registry URL for the current CLI version.
 * @returns Absolute HTTPS URL to `packages/registry/registry.json`.
 */
async function defaultRegistryUrl(): Promise<string> {
	const pkg = await readJsonFileAsync(
		path.resolve(__dirname, "../../package.json"),
		"CLI package.json",
	);
	return publishedRegistryUrl(cliPackageVersion(pkg));
}

/**
 * Print the active registry source and config file path to stdout.
 * @param registry - Registry URL or local path currently in effect.
 * @param filePath - Absolute path of the config file.
 */
function printConfiguration(registry: string, filePath: string): void {
	console.log();
	console.log(primaryText("Configuration"));
	console.log(dimText(`  registry:    ${registry}`));
	console.log(dimText(`  config file: ${filePath}`));
	console.log();
}

/**
 * Assert that a local registry path's stats point to a regular file.
 * @param source - Original source string passed by user.
 * @param absolutePath - Absolute path on the filesystem.
 * @param stat - File system stats.
 * @throws Error when the path is a symbolic link, directory, or special node.
 */
function assertLocalRegistryStatIsFile(
	source: string,
	absolutePath: string,
	stat: fs.Stats,
): void {
	if (stat.isSymbolicLink())
		throw new Error(
			`Registry path "${source}" points to ${absolutePath}, which is a symbolic link.`,
		);
	if (stat.isDirectory())
		throw new Error(
			`Registry path "${source}" points to ${absolutePath}, which is not a file.`,
		);
	if (!stat.isFile())
		throw new Error(
			`Registry path "${source}" points to ${absolutePath}, which is neither a file nor a directory.`,
		);
}

/**
 * Validate and resolve a local registry path to an absolute path.
 * @param source - Local path passed to config.
 * @returns Absolute filesystem path.
 * @throws Error when the path does not exist, is a symlink, or is not a regular file.
 */
async function toPersistedLocalRegistryPath(source: string): Promise<string> {
	const absolutePath = path.resolve(process.cwd(), source);
	let stat: fs.Stats;
	try {
		stat = await fs.promises.lstat(absolutePath);
	} catch (error) {
		if (isMissingPathError(error))
			throw new Error(
				`Registry path "${source}" does not exist (looked up as ${absolutePath}). Pass an HTTPS URL or a path to an existing registry.json.`,
			);
		throw error;
	}

	assertLocalRegistryStatIsFile(source, absolutePath, stat);
	return absolutePath;
}

/**
 * Validate a registry source and return the value to write to the config file.
 * @param source - Registry URL or local path (already trimmed).
 * @returns HTTPS URL or absolute local file path ready for the config file.
 * @throws Error when the source is empty, is not a valid HTTPS URL, uses another URL scheme, or is not an existing regular file.
 */
async function toPersistedRegistrySource(source: string): Promise<string> {
	if (!source) throw new Error("Registry source must not be empty.");

	if (isAbsoluteHttpUrl(source)) {
		let url: URL;
		try {
			url = new URL(source);
		} catch {
			throw new Error(`Registry URL "${source}" is not a valid URL.`);
		}
		assertSafeRemoteUrl(url);
		return url.href;
	}

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source))
		throw new Error(
			"Registry source must be an HTTPS URL or a local file path.",
		);

	return toPersistedLocalRegistryPath(source);
}

/**
 * Persist a default registry source to the global config.
 * @param source - Optional registry URL or local path from the CLI.
 * @param env - Environment used for config path resolution. Defaults to `process.env`.
 * @returns Absolute path of the config file that was written.
 * @throws Error when the source is empty, fails remote registry URL policy, or is not an existing file.
 */
export async function configSetCommand(
	source?: string,
	env?: NodeJS.ProcessEnv,
): Promise<string> {
	let input = source?.trim() ?? "";
	if (!input)
		input = await textInput("Registry URL or local path", {
			placeholder: "https://example.com/registry.json",
			required: true,
		});

	const toStore = await toPersistedRegistrySource(input);
	const existing = await readConfig(env);
	await writeConfig({ ...existing, registry: toStore }, env);
	const filePath = configPath(env);
	printConfiguration(toStore, filePath);

	return filePath;
}

/**
 * Print the saved registry, or the bundled default registry URL when unset.
 * @param env - Environment used for config path resolution. Defaults to `process.env`.
 */
export async function configGetCommand(env?: NodeJS.ProcessEnv): Promise<void> {
	const config = await readConfig(env);
	const filePath = configPath(env);
	const registry = config.registry ?? (await defaultRegistryUrl());
	printConfiguration(registry, filePath);
}

/**
 * Clear the saved registry source and fall back to the published default.
 * @param env - Environment used for config path resolution. Defaults to `process.env`.
 * @returns True when a previously saved registry was cleared.
 */
export async function configUnsetCommand(
	env?: NodeJS.ProcessEnv,
): Promise<boolean> {
	const cleared = await unsetRegistryConfig(env);
	const filePath = configPath(env);
	const registry = await defaultRegistryUrl();
	printConfiguration(registry, filePath);

	return cleared;
}
