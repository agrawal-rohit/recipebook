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
import { listCommand } from "./list";

/** Subcommands of `pebbles config`, dispatched from one CAC command. */
enum ConfigAction {
	GET = "get",
	SET = "set",
	UNSET = "unset",
}

/**
 * Narrow CAC's variadic add args to a string list.
 * @param items - Positional item ids from CAC.
 * @returns Item id tokens, or an empty list when none were provided.
 * @throws Error when the value is not a string array.
 */
function addItemArgs(items: unknown): string[] {
	if (items === undefined) return [];
	if (!Array.isArray(items) || items.some((item) => typeof item !== "string"))
		throw new Error("add expected a list of item ids.");
	return items;
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
 * Narrow CAC's `--type` option.
 * @param type - Parsed CAC option value.
 * @returns A string, string list, or `undefined` when the flag is omitted.
 * @throws Error when the value is present but not a string or string list.
 */
function listTypeOption(type: unknown): string | string[] | undefined {
	if (type === undefined) return undefined;
	if (typeof type === "string") return type;
	if (Array.isArray(type) && type.every((entry) => typeof entry === "string"))
		return type;
	throw new Error("--type must be a string or a list of strings.");
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
 * Parse a `pebbles config` action token.
 * @param action - Raw CAC action argument.
 * @returns A known {@link ConfigAction}.
 * @throws Error when `action` is not get, set, or unset.
 */
function parseConfigAction(action: unknown): ConfigAction {
	const usage = "Usage: pebbles config <get|set|unset> [source]";
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
 * Dispatch a parsed `pebbles config` action.
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
		"add [...items]",
		"Add registry items to the current working directory",
	);
	addCmd.option("--overwrite", "Overwrite existing files");
	addCmd.action(
		async (items: unknown, options: { overwrite?: unknown } = {}) => {
			await runCliCommand(async () => {
				const { registry, indexLocation } = await loadRegistry();
				await animatedIntro("adding registry items");
				await addCommand(registry, indexLocation, {
					items: addItemArgs(items),
					overwrite: optionalBooleanFlag(options.overwrite, "--overwrite"),
				});
			});
		},
	);

	const listCmd = app.command("list", "List available registry items");
	listCmd.option(
		"--type <types>",
		"Filter by type: all, or comma-separated types. Prompts for type selection when omitted",
	);
	listCmd.action(async (options: { type?: unknown } = {}) => {
		await runCliCommand(async () => {
			const { registry } = await loadRegistry();
			await animatedIntro("here's the menu");
			await listCommand(registry, listTypeOption(options.type));
		});
	});

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
