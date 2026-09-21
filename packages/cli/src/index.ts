import cac from "cac";
import { readConfig } from "./cli/config";
import { registerCommandsCli } from "./commands";
import { loadRuntimeRegistry } from "./utils/registry";

export { printError } from "./cli/errors";

/**
 * Narrow the global `--registry` flag to a source string.
 * @param flag - Parsed CAC `--registry` value.
 * @returns Trimmed source, or `undefined` when the flag is omitted.
 * @throws Error when the flag is present but not a non-empty string.
 */
function registryFlagValue(flag: unknown): string | undefined {
	if (flag === undefined) return undefined;
	if (typeof flag !== "string" || !flag.trim())
		throw new Error("--registry requires a non-empty URL or file path.");
	return flag.trim();
}

/** Run the cheetos CLI. */
export default async function run(): Promise<void> {
	const app = cac("cheetos");
	app.option("--registry <source>", "Use a custom registry URL");

	/**
	 * Load the runtime registry from the parsed `--registry` flag.
	 * @returns Parsed registry and the index location it was loaded from.
	 */
	async function loadRegistry() {
		const flag = registryFlagValue(app.options.registry);
		if (flag) return loadRuntimeRegistry(flag);

		const saved = await readConfig();
		return loadRuntimeRegistry(undefined, saved.registry);
	}

	registerCommandsCli(app, loadRegistry);
	app.help();

	// Parse first so async actions can be awaited.
	app.parse(process.argv, { run: false });
	await app.runMatchedCommand();

	// CAC already printed `--help` and then unset the matched command.
	if (!app.matchedCommand && !app.options.help) app.outputHelp();
}
