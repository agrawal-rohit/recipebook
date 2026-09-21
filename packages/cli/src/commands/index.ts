import type { CAC } from "cac";
import { animatedIntro } from "../cli/animated-intro";
import { NoRegistrySourceError, runCliCommand } from "../cli/errors";
import type { LoadedRegistry } from "../utils/registry";
import { addCommand } from "./add";
import {
	configGetCommand,
	configSetCommand,
	configUnsetCommand,
} from "./config";

/** Subcommands of `cheetos configure`, dispatched from one CAC command. */
enum ConfigureAction {
	GET = "get",
	SET = "set",
	UNSET = "unset",
}

/**
 * Narrow CAC's optional `add [item]` positional to a zero-or-one item list.
 * @param item - Positional item id from CAC, or `undefined` when omitted.
 * @param leftoverArgs - Remaining positional argv after the first item (CAC
 *   ignores extras for `[item]`; we reject them so `add` stays one-at-a-time).
 * @returns One item id, or an empty list when none was provided.
 * @throws Error when the value is present but not a string, or extras remain.
 */
function addItemArg(item: unknown, leftoverArgs: string[] = []): string[] {
	if (leftoverArgs.length > 0)
		throw new Error("add installs one registry item at a time.");
	if (item === undefined) return [];
	if (typeof item !== "string")
		throw new Error("add expected a registry item id.");
	return [item];
}

/**
 * Narrow a boolean CLI flag.
 * @param value - Parsed CAC option value.
 * @param name - Flag name for error messages (e.g. `"--overwrite"`).
 * @returns `true` when the flag is set, otherwise `undefined`.
 * @throws Error when the value is present but not a boolean.
 */
function optionalBooleanFlag(value: unknown, name: string): true | undefined {
	if (value === undefined || value === false) return undefined;
	if (value === true) return true;
	throw new Error(`Option ${name} must be a boolean flag.`);
}

/**
 * Narrow an optional positional string argument.
 * @param value - Parsed CAC argument.
 * @param label - Noun phrase for error messages.
 * @returns The string, or `undefined` when omitted.
 * @throws Error when the value is present but not a string.
 */
function optionalStringArg(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${label} must be a string.`);
	return value;
}

/**
 * Parse a `cheetos configure` action token.
 * @param action - Raw CAC action argument.
 * @returns A known {@link ConfigureAction}.
 * @throws Error when `action` is not get, set, or unset.
 */
function parseConfigureAction(action: unknown): ConfigureAction {
	const usage = "Usage: cheetos configure <get|set|unset> [source]";
	if (typeof action !== "string")
		throw new Error(`Unknown configure action "${String(action)}". ${usage}`);

	switch (action) {
		case ConfigureAction.GET:
		case ConfigureAction.SET:
		case ConfigureAction.UNSET:
			return action;
		default:
			throw new Error(`Unknown configure action "${action}". ${usage}`);
	}
}

/**
 * Reject a registry source passed to a configure subcommand that does not accept one.
 * @param action - Configure subcommand name, for the error message.
 * @param registrySource - Optional source parsed from CAC.
 * @throws Error when `registrySource` is present.
 */
function assertNoConfigSource(
	action: ConfigureAction,
	registrySource: string | undefined,
): void {
	if (registrySource !== undefined)
		throw new Error(`configure ${action} does not take a registry source.`);
}

/**
 * Dispatch a parsed `cheetos configure` action.
 * @param action - Raw CAC action argument.
 * @param source - Optional registry source from CAC.
 * @throws Error when the action is unknown, or get/unset is given a source.
 */
async function runConfigureAction(
	action: unknown,
	source?: unknown,
): Promise<void> {
	const parsedAction = parseConfigureAction(action);
	const registrySource = optionalStringArg(source, "configure source");

	switch (parsedAction) {
		case ConfigureAction.GET:
			assertNoConfigSource(parsedAction, registrySource);
			await animatedIntro("fetching the configuration");
			await configGetCommand();
			return;
		case ConfigureAction.SET:
			await animatedIntro("updating the configuration");
			await configSetCommand(registrySource);
			return;
		case ConfigureAction.UNSET:
			assertNoConfigSource(parsedAction, registrySource);
			await animatedIntro("clearing the configuration");
			await configUnsetCommand();
			return;
		/* v8 ignore start */
		// Stryker disable all: unreachable exhaustive default
		default: {
			const _never: never = parsedAction;
			throw new Error(`Unhandled configure action: ${String(_never)}`);
		}
		// Stryker restore all
		/* v8 ignore stop */
	}
}

/**
 * Load a registry, prompting the user to add a source when none is configured.
 * @param loadRegistry - Locator used by commands that need registry data.
 * @returns The loaded registry and its index location.
 * @throws {@link NoRegistrySourceError} when no source is configured on a
 *   non-TTY stream, or the source added at the prompt still cannot be loaded.
 */
async function loadRegistryOrPromptSource(
	loadRegistry: () => Promise<LoadedRegistry>,
): Promise<LoadedRegistry> {
	try {
		return await loadRegistry();
	} catch (error) {
		if (!(error instanceof Error) || error.name !== "NoRegistrySourceError")
			throw error;

		// A prompt would hang CI/scripts; fail fast instead.
		if (!process.stdin.isTTY) throw error;

		// Prompt and persist a source, then re-read config so the retry resolves it.
		await configSetCommand(undefined);
		return loadRegistry();
	}
}

/**
 * Register CLI commands and their options.
 * @param app - CAC application instance.
 * @param loadRegistry - Loader used by commands that need registry data.
 */
export function registerCommandsCli(
	app: CAC,
	loadRegistry: () => Promise<LoadedRegistry>,
): void {
	const addCmd = app.command(
		"add [item]",
		"Add a registry item to the current working directory",
	);
	addCmd.option("--overwrite", "Overwrite existing files");
	addCmd.action(
		async (item: unknown, options: { overwrite?: unknown } = {}) => {
			await runCliCommand(async () => {
				// CAC binds only `[item]`; extras stay in `app.args` after the first.
				const leftoverArgs = (app.args ?? []).slice(item === undefined ? 0 : 1);
				const items = addItemArg(item, leftoverArgs);
				const overwrite = optionalBooleanFlag(options.overwrite, "--overwrite");
				const { registry, indexLocation } =
					await loadRegistryOrPromptSource(loadRegistry);
				await animatedIntro("adding registry item");
				await addCommand(registry, indexLocation, { items, overwrite });
			});
		},
	);

	const configCmd = app.command(
		"configure <action> [source]",
		"Get, set, or unset the default registry source",
	);
	configCmd.usage("configure <get|set|unset> [source]");
	configCmd.action(async (action: unknown, source?: unknown) => {
		await runCliCommand(async () => {
			await runConfigureAction(action, source);
		});
	});
}
