import fs from "node:fs";
import path from "node:path";
import {
	buildPackageInstallCommands,
	type CompiledItem,
	isMissingPathError,
	isPackageManagerForEcosystem,
	mergeCommandSet,
	mergeDependencySet,
	mergeEcosystemMaps,
	type PackageInstallCommand,
	PathKind,
	pathKindAsync,
	RegistryDependencyKind,
	RegistryEcosystem,
	type RegistryEcosystemDependencies,
	type RegistryPackageManager,
	readJsonFileAsync,
	runArgvAsync,
	uniqueSorted,
	writeFileAsync,
} from "@recipebook/core";
import { primaryText } from "../cli/labels";
import { confirmInput } from "../cli/prompts";
import { runWithTasks } from "../cli/tasks";

/**
 * Collect install commands and package names from merged ecosystem dependencies.
 * @param merged - Merged ecosystem dependency sets.
 * @param packageManager - Selected package manager.
 * @returns Install commands and distinct package names.
 */
function collectEcosystemInstallPlan(
	merged: Partial<
		Record<RegistryEcosystem, RegistryEcosystemDependencies[RegistryEcosystem]>
	>,
	packageManager: RegistryPackageManager,
): { commands: PackageInstallCommand[]; packageNames: string[] } {
	const commands: PackageInstallCommand[] = [];
	const names = new Set<string>();

	for (const ecosystem of Object.values(RegistryEcosystem)) {
		const dependencySet = merged[ecosystem];
		/* v8 ignore next -- only npm exists today; keep the loop multi-ecosystem ready */
		if (!dependencySet) continue;
		if (!isPackageManagerForEcosystem(ecosystem, packageManager))
			throw new Error(
				`Cannot install ${ecosystem} packages with package manager "${packageManager}".`,
			);

		commands.push(
			...buildPackageInstallCommands(ecosystem, packageManager, dependencySet),
		);
		for (const name of [
			...(dependencySet[RegistryDependencyKind.RUNTIME] ?? []),
			...(dependencySet[RegistryDependencyKind.DEV] ?? []),
		]) {
			names.add(name);
		}
	}

	return { commands, packageNames: uniqueSorted([...names]) };
}

/**
 * Optionally run package install commands from payload declarations.
 * @param packageDeclarations - Per-payload package maps collected during writes.
 * @param projectDir - Absolute project root.
 * @param packageManager - Selected package manager.
 * @returns Display commands still left for the user when installation was skipped.
 */
export async function installDeclaredPackages(
	packageDeclarations: RegistryEcosystemDependencies[],
	projectDir: string,
	packageManager: RegistryPackageManager,
): Promise<string[]> {
	if (packageDeclarations.length === 0) return [];

	const merged = mergeEcosystemMaps(mergeDependencySet, ...packageDeclarations);
	if (!merged) return [];

	const { commands, packageNames } = collectEcosystemInstallPlan(
		merged,
		packageManager,
	);
	if (commands.length === 0 || packageNames.length === 0) return [];

	console.log();
	console.log("Packages to install:");
	for (const name of packageNames) console.log(`  - ${name}`);

	const shouldInstall = await confirmInput(
		"Install required dependencies?",
		{},
		true,
	);

	if (!shouldInstall) return commands.map((command) => command.display);

	await assertProjectDirIsDirectory(projectDir);

	console.log();
	for (const command of commands) {
		await runWithTasks(command.display, async () => {
			await runArgvAsync(command.executable, command.args, {
				cwd: projectDir,
				stdio: "inherit",
			});
		});
	}

	return [];
}

/**
 * Merge payload `commands` into the project's package.json scripts.
 * @param projectDir - Absolute project root.
 * @param compiledItems - Compiled items whose commands may be merged.
 * @param overwrite - Skip replacement prompts when true.
 * @throws Error when npm commands are declared but package.json is missing, a directory, or invalid JSON.
 */
export async function mergeProjectCommands(
	projectDir: string,
	compiledItems: CompiledItem[],
	overwrite = false,
): Promise<void> {
	const commands = mergeEcosystemMaps(
		mergeCommandSet,
		...compiledItems.map((item) => item.commands),
	);
	if (!commands) return;

	for (const ecosystem of Object.values(RegistryEcosystem)) {
		const ecosystemCommands = commands[ecosystem];
		/* v8 ignore start -- only npm exists today; keep the loop multi-ecosystem ready */
		if (!ecosystemCommands || Object.keys(ecosystemCommands).length === 0)
			continue;
		/* v8 ignore stop */

		if (ecosystem === RegistryEcosystem.NPM) {
			await mergeNpmProjectCommands(projectDir, ecosystemCommands, overwrite);
		} else {
			/* v8 ignore start */
			// Stryker disable all: unreachable exhaustive default
			const exhaustive: never = ecosystem;
			throw new Error(
				`Unsupported ecosystem for project commands: ${String(exhaustive)}`,
			);
			// Stryker restore all
			/* v8 ignore stop */
		}
	}
}

/** One payload script that would replace a different existing script. */
interface ScriptReplacement {
	/** package.json script name. */
	name: string;
	/** Command from the compiled item. */
	command: string;
}

/**
 * Partition npm commands into new additions and existing script replacements.
 * @param npmCommands - Commands from the payload.
 * @param scripts - Existing package.json scripts.
 * @returns Partitioned additions and replacements.
 * @throws Error when a script name is invalid or unsafe.
 */
function partitionScriptReplacements(
	npmCommands: Record<string, string>,
	scripts: Record<string, string>,
): { additions: ScriptReplacement[]; replacements: ScriptReplacement[] } {
	const additions: ScriptReplacement[] = [];
	const replacements: ScriptReplacement[] = [];

	for (const [name, command] of Object.entries(npmCommands)) {
		assertSafeScriptName(name);
		const existing = scripts[name];
		if (existing === command) continue;
		if (existing === undefined) additions.push({ name, command });
		else replacements.push({ name, command });
	}

	return { additions, replacements };
}

/**
 * Merge npm-ecosystem commands into package.json scripts.
 * New script names are applied without prompting. Replacements are confirmed once unless `overwrite`.
 * @param projectDir - Absolute project root.
 * @param npmCommands - Script name → command map.
 * @param overwrite - Skip replacement prompts when true.
 * @throws Error when package.json is missing, a directory, or invalid.
 */
async function mergeNpmProjectCommands(
	projectDir: string,
	npmCommands: Record<string, string>,
	overwrite: boolean,
): Promise<void> {
	const packageJsonPath = path.join(projectDir, "package.json");
	await assertPackageJsonIsFile(packageJsonPath);

	const packageJson = packageJsonObject(
		await readJsonFileAsync(packageJsonPath, "package.json"),
	);
	const scripts = stringScriptMap(packageJson.scripts);
	const { additions, replacements } = partitionScriptReplacements(
		npmCommands,
		scripts,
	);

	const replaceExisting = await confirmScriptReplacements(
		replacements,
		overwrite,
	);
	if (additions.length === 0 && (!replaceExisting || replacements.length === 0))
		return;

	if (replaceExisting) {
		for (const { name, command } of replacements) scripts[name] = command;
	}
	for (const { name, command } of additions) scripts[name] = command;

	packageJson.scripts = scripts;
	await assertPackageJsonIsFile(packageJsonPath);
	await writeFileAsync(
		packageJsonPath,
		`${JSON.stringify(packageJson, null, 2)}\n`,
	);
}

/**
 * Assert the install cwd exists as a directory.
 * @param projectDir - Absolute project root.
 * @throws Error when the path is missing or not a directory.
 */
async function assertProjectDirIsDirectory(projectDir: string): Promise<void> {
	const kind = await pathKindAsync(projectDir);
	switch (kind) {
		case PathKind.DIRECTORY:
			return;
		case PathKind.ABSENT:
			throw new Error(
				"Cannot install packages: project directory was not found.",
			);
		case PathKind.FILE:
			throw new Error(
				"Cannot install packages: project directory exists and is a file.",
			);
		/* v8 ignore start */
		// Stryker disable all: unreachable exhaustive default
		default: {
			const _exhaustive: never = kind;
			throw new Error(`Unhandled path kind: ${String(_exhaustive)}`);
		}
		// Stryker restore all
		/* v8 ignore stop */
	}
}

/**
 * Assert package.json exists as a regular file (not a symlink or directory).
 * @param packageJsonPath - Absolute path to package.json.
 * @throws Error when the path is missing, a directory, a symlink, or an unexpected kind.
 */
async function assertPackageJsonIsFile(packageJsonPath: string): Promise<void> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.lstat(packageJsonPath);
	} catch (error) {
		if (isMissingPathError(error))
			throw new Error(
				"Cannot merge package.json scripts: package.json was not found in the project root.",
			);
		throw error;
	}

	if (stat.isSymbolicLink())
		throw new Error(
			`Cannot merge package.json scripts: ${primaryText("package.json")} exists and is a symbolic link.`,
		);
	if (stat.isDirectory())
		throw new Error(
			`Cannot merge package.json scripts: ${primaryText("package.json")} exists and is a directory.`,
		);
	if (!stat.isFile())
		throw new Error(
			`Cannot merge package.json scripts: ${primaryText("package.json")} exists but is neither a file nor a directory.`,
		);
}

/**
 * Narrow a parsed package.json document to a JSON object.
 * @param value - Parsed JSON value.
 * @returns Object document.
 * @throws Error when the document is not a JSON object.
 */
function packageJsonObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("package.json must be a JSON object.");
	return value as Record<string, unknown>;
}

/**
 * Narrow package.json `scripts` to a string map.
 * @param scripts - Raw `scripts` field.
 * @returns Copy of the script map, or `{}` when omitted.
 * @throws Error when `scripts` is present but not a string map.
 */
function stringScriptMap(scripts: unknown): Record<string, string> {
	if (scripts === undefined) return {};
	if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts))
		throw new Error("package.json scripts must be an object.");
	const mapped: Record<string, string> = Object.create(null);
	for (const [name, command] of Object.entries(scripts)) {
		assertSafeScriptName(name);
		if (typeof command !== "string")
			throw new Error(`package.json script "${name}" must be a string.`);
		mapped[name] = command;
	}
	return mapped;
}

/**
 * Reject empty or prototype-polluting package.json script names.
 * @param name - Script key from the payload or existing package.json.
 * @throws Error when the name is empty or `__proto__`.
 */
function assertSafeScriptName(name: string): void {
	if (name.length === 0)
		throw new Error("package.json script name must not be empty.");
	if (name === "__proto__")
		throw new Error('package.json script "__proto__" is not allowed.');
}

/**
 * Confirm replacing existing package.json scripts that differ from the payload.
 * @param replacements - Scripts that already exist with a different command.
 * @param overwrite - Skip the prompt when true.
 * @returns False when the user declines; existing scripts are kept.
 */
async function confirmScriptReplacements(
	replacements: ScriptReplacement[],
	overwrite: boolean,
): Promise<boolean> {
	if (overwrite || replacements.length === 0) return true;

	console.log();
	if (replacements.length === 1) {
		const { name, command } = replacements[0];
		return confirmInput(
			`package.json script "${primaryText(name)}" already exists. Overwrite with "${command}"?`,
			{},
			false,
		);
	}

	console.log("The following package.json scripts already exist:");
	for (const { name, command } of replacements)
		console.log(`  - ${primaryText(name)} → ${command}`);
	return confirmInput("Overwrite these package.json scripts?", {}, false);
}
