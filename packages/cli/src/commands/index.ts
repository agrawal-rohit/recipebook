import type { CAC } from "cac";
import { animatedIntro } from "../cli/animated-intro";
import { runCliCommand } from "../cli/errors";
import type { LoadedRegistry } from "../utils/registry";
import { addCommand } from "./add";
import {
	configGetCommand,
	configSetCommand,
	configUnsetCommand,
} from "./config";

/** Subcommands of `cheetos config`, dispatched from one CAC command. */
enum ConfigAction {
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
 * Parse a `cheetos config` action token.
 * @param action - Raw CAC action argument.
 * @returns A known {@link ConfigAction}.
 * @throws Error when `action` is not get, set, or unset.
 */
function parseConfigAction(action: unknown): ConfigAction {
	const usage = "Usage: cheetos config <get|set|unset> [source]";
	if (typeof action !== "string")
		throw new Error(`Unknown config action "${String(action)}". ${usage}`);

	switch (action) {
		case ConfigAction.GET:
		case ConfigAction.SET:
		case ConfigAction.UNSET:
			return action;
		default:
			throw new Error(`Unknown config action "${action}". ${usage}`);
	}
}

/**
 * Reject a registry source passed to a config subcommand that does not accept one.
 * @param action - Config subcommand name, for the error message.
 * @param registrySource - Optional source parsed from CAC.
 * @throws Error when `registrySource` is present.
 */
function assertNoConfigSource(
	action: ConfigAction,
	registrySource: string | undefined,
): void {
	if (registrySource !== undefined)
		throw new Error(`config ${action} does not take a registry source.`);
}

/**
 * Dispatch a parsed `cheetos config` action.
 * @param action - Raw CAC action argument.
 * @param source - Optional registry source from CAC.
 * @throws Error when the action is unknown, or get/unset is given a source.
 */
async function runConfigAction(
	action: unknown,
	source?: unknown,
): Promise<void> {
	const parsedAction = parseConfigAction(action);
	const registrySource = optionalStringArg(source, "config source");

	switch (parsedAction) {
		case ConfigAction.GET:
			assertNoConfigSource(parsedAction, registrySource);
			await animatedIntro("fetching the configuration");
			await configGetCommand();
			return;
		case ConfigAction.SET:
			await animatedIntro("updating the configuration");
			await configSetCommand(registrySource);
			return;
		case ConfigAction.UNSET:
			assertNoConfigSource(parsedAction, registrySource);
			await animatedIntro("clearing the configuration");
			await configUnsetCommand();
			return;
		/* v8 ignore start */
		// Stryker disable all: unreachable exhaustive default
		default: {
			const _never: never = parsedAction;
			throw new Error(`Unhandled config action: ${String(_never)}`);
		}
		// Stryker restore all
		/* v8 ignore stop */
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
				const { registry, indexLocation } = await loadRegistry();
				await animatedIntro("adding registry item");
				await addCommand(registry, indexLocation, { items, overwrite });
			});
		},
	);

	const configCmd = app.command(
		"config <action> [source]",
		"Get, set, or unset the default registry source",
	);
	configCmd.usage("config <get|set|unset> [source]");
	configCmd.action(async (action: unknown, source?: unknown) => {
		await runCliCommand(async () => {
			await runConfigAction(action, source);
		});
	});
}
