/** Subcommands of `recipebook configure`, dispatched from one CAC command. */
export enum ConfigureAction {
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
export function addItemArg(
	item: unknown,
	leftoverArgs: string[] = [],
): string[] {
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
export function optionalBooleanFlag(
	value: unknown,
	name: string,
): true | undefined {
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
export function optionalStringArg(
	value: unknown,
	label: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${label} must be a string.`);
	return value;
}

/**
 * Narrow an optional string-valued CLI flag.
 * @param value - Parsed CAC option value.
 * @param name - Flag name for error messages (e.g. `"--types-file-name"`).
 * @returns The string, or `undefined` when unset.
 * @throws Error when `value` is `true` (a valueless flag) or not a string.
 */
export function optionalStringFlag(
	value: unknown,
	name: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (value === true) throw new Error(`Option ${name} requires a value.`);
	if (typeof value !== "string")
		throw new Error(`Option ${name} must be a string.`);
	return value;
}

/**
 * Narrow the repeatable `--external` flag to a package list.
 * @param value - Parsed CAC option value (a string or array of strings).
 * @returns External package names, or `undefined` when unset.
 * @throws Error when `value` is `true` (a valueless flag) or not a string.
 */
export function externalPackagesArg(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (value === true) throw new Error("Option --external requires a value.");
	const entries = Array.isArray(value) ? value : [value];
	return entries.map((entry) => {
		if (entry === true) throw new Error("Option --external requires a value.");
		if (typeof entry !== "string")
			throw new Error("Option --external must be a string or list of strings.");
		return entry;
	});
}

/**
 * Parse a `recipebook configure` action token.
 * @param action - Raw CAC action argument.
 * @returns A known {@link ConfigureAction}.
 * @throws Error when `action` is not get, set, or unset.
 */
export function parseConfigureAction(action: unknown): ConfigureAction {
	const usage = "Usage: recipebook configure <get|set|unset> [source]";
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
