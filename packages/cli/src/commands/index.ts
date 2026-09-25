import type { CAC } from "cac";
import { animatedIntro } from "../cli/animated-intro";
import { NoRegistrySourceError, runCliCommand } from "../cli/errors";
import type { LoadedRegistry } from "../utils/registry";
import { addCommand } from "./add";
import {
	addItemArg,
	ConfigureAction,
	externalPackagesArg,
	optionalBooleanFlag,
	optionalStringArg,
	optionalStringFlag,
	parseConfigureAction,
} from "./args";
import { buildCommand } from "./build";
import {
	configGetCommand,
	configSetCommand,
	configUnsetCommand,
} from "./config";

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
 * Dispatch a parsed `recipebook configure` action.
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
		await configSetCommand();
		return loadRegistry();
	}
}

/**
 * Register the `recipebook add [item]` command.
 * @param app - CAC application instance.
 * @param loadRegistry - Loader used by commands that need registry data.
 */
function registerAddCommand(
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
}

/**
 * Register the `recipebook configure <action> [source]` command.
 * @param app - CAC application instance.
 */
function registerConfigureCommand(app: CAC): void {
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

/**
 * Register the `recipebook build [sourceDir] [outDir]` command.
 * @param app - CAC application instance.
 */
function registerBuildCommand(app: CAC): void {
	const buildCmd = app.command(
		"build [sourceDir] [outDir]",
		"Compile a registry source directory into a compiled registry",
	);
	buildCmd.option(
		"--registry-file-name <name>",
		"Index file name under outDir",
	);
	buildCmd.option(
		"--item-manifest-file-name <name>",
		"Item manifest file name under an item folder",
	);
	buildCmd.option(
		"--types-file-name <name>",
		"Types document path under sourceDir",
	);
	buildCmd.option(
		"--conditions-file-name <name>",
		"Shared conditions path under sourceDir",
	);
	buildCmd.option(
		"--compiled-dir-name <name>",
		"Index-relative directory for compiled output",
	);
	buildCmd.option(
		"--external <package>",
		"Extra package marked external for install/handler bundles (repeatable)",
	);
	buildCmd.action(
		async (
			sourceDir?: unknown,
			outDir?: unknown,
			options: {
				registryFileName?: unknown;
				itemManifestFileName?: unknown;
				typesFileName?: unknown;
				conditionsFileName?: unknown;
				compiledDirName?: unknown;
				external?: unknown;
				"--"?: string[];
			} = {},
		) => {
			await runCliCommand(async () => {
				// CAC stores every positional in `app.args`; reject anything beyond
				// the two bound positionals so a stray package cannot become a dir.
				const boundCount =
					(sourceDir === undefined ? 0 : 1) + (outDir === undefined ? 0 : 1);
				if ((app.args ?? []).slice(boundCount).length > 0)
					throw new Error(
						"build takes at most a source directory and an output directory; pass one package per --external flag.",
					);

				// CAC stores post-"--" tokens in `options["--"]` and never binds them to
				// positionals; rejecting them avoids silently building the wrong tree.
				if ((options["--"] ?? []).length > 0)
					throw new Error(
						'build does not accept arguments after "--"; pass the source and output directories as regular positional arguments.',
					);
				const source = optionalStringArg(sourceDir, "build sourceDir") ?? ".";
				const out = optionalStringArg(outDir, "build outDir") ?? "dist";
				const overrides = {
					registryFileName: optionalStringFlag(
						options.registryFileName,
						"--registry-file-name",
					),
					itemManifestFileName: optionalStringFlag(
						options.itemManifestFileName,
						"--item-manifest-file-name",
					),
					typesFileName: optionalStringFlag(
						options.typesFileName,
						"--types-file-name",
					),
					conditionsFileName: optionalStringFlag(
						options.conditionsFileName,
						"--conditions-file-name",
					),
					compiledDirName: optionalStringFlag(
						options.compiledDirName,
						"--compiled-dir-name",
					),
					bundleExternalPackages: externalPackagesArg(options.external),
				};
				await animatedIntro("building the registry");
				await buildCommand(source, out, overrides);
			});
		},
	);
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
	registerAddCommand(app, loadRegistry);
	registerConfigureCommand(app);
	registerBuildCommand(app);
}
