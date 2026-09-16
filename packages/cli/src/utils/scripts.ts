import {
	assertScriptsAllowed,
	classifyRegistryTrust,
	collectDeclaredScriptUris,
	createHandlerRuntime,
	createRejectedScriptExecutor,
	createScriptExecutor,
	type HandlerRuntime,
	isDirectoryAsync,
	isFileAsync,
	localScriptPath,
	type Registry,
	type RegistryContext,
	type RegistryPackageManager,
	type RegistryTrust,
	readFileAsync,
	runAsync,
	sandboxRunnerPath,
	setScriptExecutor,
} from "@pebbles/core";
import { bundledRegistryPath } from "./registry";

/**
 * Build project-scoped helpers that catalog scripts may call (`isFile`, `readFile`, `run`).
 * Paths are confined to `projectDir` by core; `run` executes with that directory as cwd.
 * @param projectDir - Absolute project root.
 * @returns Handler runtime bound to the project filesystem and shell.
 */
export function projectScriptHelpers(projectDir: string): HandlerRuntime {
	return createHandlerRuntime(projectDir, {
		isFile: isFileAsync,
		isDirectory: isDirectoryAsync,
		readFile: readFileAsync,
		run: (command) => runAsync(command, { cwd: projectDir, stdio: "pipe" }),
	});
}

/**
 * Classify trust, collect infer vs mutation scripts, and install an executor.
 * Always installs an executor so a later load cannot fall back to in-process `require`.
 * @param options - Index location, registry, candidate items, and project dir.
 * @returns Trust classification and which script kinds may load.
 */
export async function prepareScriptExecution(options: {
	indexLocation: string;
	registry: Registry;
	itemIds: readonly string[];
	projectDir: string;
	selectedItems?: readonly string[];
	context?: RegistryContext;
	packageManager?: RegistryPackageManager;
}): Promise<{
	trust: RegistryTrust;
	allowInfer: boolean;
	allowMutation: boolean;
}> {
	const trust = classifyRegistryTrust(
		options.indexLocation,
		bundledRegistryPath(),
	);
	const scripts = collectDeclaredScriptUris(options.registry, options.itemIds, {
		selectedItems: options.selectedItems,
		context: options.context,
		packageManager: options.packageManager,
	});

	const policy = await assertScriptsAllowed(trust, scripts);

	setScriptExecutor(
		policy.allowInfer || policy.allowMutation
			? createScriptExecutor({
					locateScriptPath: localScriptPath,
					scriptIntegrity: options.registry.scriptIntegrity,
					mode: "sandbox",
					projectDir: options.projectDir,
					runnerPath: sandboxRunnerPath(),
				})
			: createRejectedScriptExecutor(),
	);

	return { trust, ...policy };
}
