import fs from "node:fs";
import path from "node:path";
import { readJsonFileAsync } from "./fs";
import type { PromptHost } from "./handlers";
import {
	type CompiledItem,
	type CompiledItemFile,
	RegistryDependencyKind,
	type RegistryDependencySet,
	RegistryEcosystem,
	type RegistryEcosystemCommands,
	type RegistryEcosystemDependencies,
} from "./schema";
import { isEscapingRelativePath } from "./urls";

/**
 * Require an absolute project directory for filesystem-based detection.
 * @param projectDir - Project root to validate.
 * @throws Error when `projectDir` is relative.
 */
function assertAbsoluteProjectDirectory(projectDir: string): void {
	if (!path.isAbsolute(projectDir))
		throw new Error("Project directory must be an absolute path.");
}

/** Pack `when` key and Mustache key for the selected package manager. */
export const PACKAGE_MANAGER_KEY = "packageManager";

/** Interpolation bindings derived from the selected package manager. */
export interface PackageManagerBindings {
	pmRun: string;
	pmExec: string;
	pmInstall: string;
	pmInstallCi: string;
	pmPublish: string;
}

/** JavaScript package managers supported for the npm ecosystem. */
export enum NpmPackageManager {
	NPM = "npm",
	PNPM = "pnpm",
	YARN = "yarn",
	BUN = "bun",
	NUB = "nub",
}

/** Package manager selected for a registry ecosystem. Add a manager enum to this union when introducing a new language. */
export type RegistryPackageManager = NpmPackageManager;

/** Planned install command ready for display or argv execution. */
export interface PackageInstallCommand {
	/** Program to spawn. */
	executable: string;
	/** Full argument vector including package names. */
	args: string[];
	/** Human-readable command line for prompts and next steps. */
	display: string;
}

/** Detection, prompt, install, and interpolation metadata for one package manager. */
export interface PackageManagerSpec {
	/** Manager id selected by the user or inferred from lockfiles. */
	manager: RegistryPackageManager;
	/** Display label for the package-manager prompt. */
	label: string;
	/** Lockfiles that identify this manager when present in the project root. */
	lockfiles: readonly string[];
	/** Argv after the executable for the manager's `run` command (e.g. `run`). */
	run: readonly string[];
	/** Argv after the executable for the manager's `exec` command (e.g. `exec`). */
	exec: readonly string[];
	/** Argv after the executable for a plain full install (local development). */
	installRegular: readonly string[];
	/** Argv after the executable for a hardened full install (CI: pinned, script-safe). */
	installCi: readonly string[];
	/** Argv after the executable for publishing workspace packages. */
	publish: readonly string[];
	/** Argv after the executable for runtime and dev package installs. */
	install: Record<RegistryDependencyKind, readonly string[]>;
}

/** Result of detecting one package manager from an ecosystem lockfile. */
export interface PackageManagerLockfileMatch {
	manager: RegistryPackageManager;
	lockfile: string;
}

/**
 * Ecosystem adapter for package manager discovery.
 * Ecosystems (npm, and in the future python, rust, etc.) implement both operations.
 */
export interface EcosystemPackageManagerAdapter {
	/**
	 * Check the ecosystem's known lockfiles.
	 * @param projectDir - Absolute project root.
	 * @param managers - Manager specs owned by the ecosystem.
	 * @param pathExists - Path existence checker. Defaults to `fs.existsSync`.
	 * @returns Matching manager and lockfile when exactly one manager matches.
	 */
	detectFromLockfiles(
		projectDir: string,
		managers: readonly PackageManagerSpec[],
		pathExists?: (absolutePath: string) => boolean,
	): PackageManagerLockfileMatch | undefined;
	/**
	 * Check the ecosystem's project manifest for a manager declaration.
	 * For npm this reads `package.json#packageManager`; another ecosystem may
	 * inspect `pyproject.toml`, `Cargo.toml`, or another manifest instead.
	 * @param projectDir - Absolute project root.
	 * @param managers - Manager specs owned by the ecosystem.
	 * @param pathExists - Path existence checker. Defaults to `fs.existsSync`.
	 * @returns Declared manager when known and valid, or undefined.
	 */
	detectFromManifest(
		projectDir: string,
		managers: readonly PackageManagerSpec[],
		pathExists?: (absolutePath: string) => boolean,
	): Promise<RegistryPackageManager | undefined>;
}

/** Package manager specs keyed by ecosystem. */
export const ecosystemManagers = {
	// First manager in each list is the CLI fallback when the user skips the prompt.
	[RegistryEcosystem.NPM]: [
		{
			manager: NpmPackageManager.NPM,
			label: "npm",
			lockfiles: ["package-lock.json", "npm-shrinkwrap.json"],
			run: ["run"],
			exec: [],
			installRegular: ["install"],
			installCi: ["ci", "--ignore-scripts"],
			publish: [
				"publish",
				"--workspaces",
				"--provenance",
				"--access",
				"public",
				"--no-git-checks",
			],
			install: {
				[RegistryDependencyKind.RUNTIME]: ["install", "--ignore-scripts"],
				[RegistryDependencyKind.DEV]: ["install", "--ignore-scripts", "-D"],
			},
		},
		{
			manager: NpmPackageManager.PNPM,
			label: "pnpm",
			lockfiles: ["pnpm-lock.yaml"],
			run: [],
			exec: ["exec"],
			installRegular: ["install"],
			installCi: ["install", "--ignore-scripts", "--frozen-lockfile"],
			publish: [
				"-r",
				"publish",
				"--provenance",
				"--access",
				"public",
				"--no-git-checks",
			],
			install: {
				[RegistryDependencyKind.RUNTIME]: ["add", "--ignore-scripts"],
				[RegistryDependencyKind.DEV]: ["add", "--ignore-scripts", "-D"],
			},
		},
		{
			manager: NpmPackageManager.YARN,
			label: "Yarn",
			lockfiles: ["yarn.lock"],
			run: [],
			exec: [],
			installRegular: ["install"],
			installCi: ["install", "--frozen-lockfile", "--ignore-scripts"],
			publish: [
				"workspaces",
				"foreach",
				"-A",
				"npm",
				"publish",
				"--provenance",
				"--access",
				"public",
			],
			install: {
				[RegistryDependencyKind.RUNTIME]: ["add", "--ignore-scripts"],
				[RegistryDependencyKind.DEV]: ["add", "--ignore-scripts", "-D"],
			},
		},
		{
			manager: NpmPackageManager.BUN,
			label: "Bun",
			lockfiles: ["bun.lock"],
			run: ["run"],
			exec: [],
			installRegular: ["install"],
			installCi: ["install", "--frozen-lockfile"],
			publish: ["publish", "--access", "public"],
			install: {
				[RegistryDependencyKind.RUNTIME]: ["add", "--ignore-scripts"],
				[RegistryDependencyKind.DEV]: ["add", "--ignore-scripts", "-D"],
			},
		},
		{
			manager: NpmPackageManager.NUB,
			label: "Nub",
			lockfiles: ["nub.lock"],
			run: ["run"],
			exec: ["exec"],
			installRegular: ["install"],
			installCi: ["install", "--ignore-scripts", "--frozen-lockfile"],
			publish: ["publish", "--access", "public"],
			install: {
				[RegistryDependencyKind.RUNTIME]: ["add", "--ignore-scripts"],
				[RegistryDependencyKind.DEV]: ["add", "--ignore-scripts", "-D"],
			},
		},
	],
} satisfies Record<RegistryEcosystem, readonly PackageManagerSpec[]>;

/**
 * Find a package-manager specification for an ecosystem.
 * @param ecosystem - Registry ecosystem that owns the manager.
 * @param candidateManager - Candidate manager id.
 * @returns Matching specification, or undefined when the manager is unsupported.
 */
function findPackageManagerSpec(
	ecosystem: RegistryEcosystem,
	candidateManager: string,
): PackageManagerSpec | undefined {
	return ecosystemManagers[ecosystem].find(
		(managerSpec) => managerSpec.manager === candidateManager,
	);
}

/**
 * Look up the package-manager spec for one ecosystem and manager id.
 * @param ecosystem - Registry ecosystem that owns the manager.
 * @param manager - Selected package manager.
 * @returns Spec for the manager.
 * @throws Error when the manager is not valid for the ecosystem.
 */
export function packageManagerSpec(
	ecosystem: RegistryEcosystem,
	manager: RegistryPackageManager,
): PackageManagerSpec {
	const managerSpec = findPackageManagerSpec(ecosystem, manager);
	if (!managerSpec) {
		throw new Error(
			`Package manager "${manager}" is not valid for ecosystem "${ecosystem}".`,
		);
	}
	return managerSpec;
}

/**
 * Whether a string is a supported package manager for the given ecosystem.
 * @param ecosystem - Registry ecosystem to validate against.
 * @param candidateManager - Candidate manager id.
 * @returns True when the candidate manager is known for that ecosystem.
 */
export function isPackageManagerForEcosystem(
	ecosystem: RegistryEcosystem,
	candidateManager: string,
): candidateManager is RegistryPackageManager {
	return findPackageManagerSpec(ecosystem, candidateManager) !== undefined;
}

/**
 * Shared helper to detect a single package manager from an array of manager specs matching file lockfiles.
 * @param projectDir - Absolute project root.
 * @param managers - Candidate manager specifications.
 * @param pathExists - Path existence checker. Defaults to `fs.existsSync`.
 * @returns Single matching manager and lockfile name, or undefined when none or multiple match.
 * @throws Error when `projectDir` is not an absolute path.
 */
export function detectPackageManagerFromLockfileList(
	projectDir: string,
	managers: readonly PackageManagerSpec[],
	pathExists: (absolutePath: string) => boolean = fs.existsSync,
): PackageManagerLockfileMatch | undefined {
	assertAbsoluteProjectDirectory(projectDir);

	const lockfileMatches: PackageManagerLockfileMatch[] = [];
	for (const managerSpec of managers) {
		const lockfileName = managerSpec.lockfiles.find((candidateLockfile) =>
			pathExists(path.join(projectDir, candidateLockfile)),
		);
		if (lockfileName)
			lockfileMatches.push({
				manager: managerSpec.manager,
				lockfile: lockfileName,
			});
	}
	if (lockfileMatches.length !== 1) return undefined;
	return lockfileMatches[0];
}

/**
 * Ecosystem adapter for npm / JavaScript package managers.
 * Reads package manager declarations from `package.json#packageManager`.
 */
export const npmEcosystemAdapter: EcosystemPackageManagerAdapter = {
	detectFromLockfiles: detectPackageManagerFromLockfileList,

	async detectFromManifest(
		projectDir: string,
		managers: readonly PackageManagerSpec[],
		pathExists: (absolutePath: string) => boolean = fs.existsSync,
	): Promise<RegistryPackageManager | undefined> {
		assertAbsoluteProjectDirectory(projectDir);

		const packageJsonPath = path.join(projectDir, "package.json");
		if (!pathExists(packageJsonPath)) return undefined;

		const packageJsonValue = await readJsonFileAsync<unknown>(
			packageJsonPath,
			"package.json",
		);
		if (
			typeof packageJsonValue !== "object" ||
			packageJsonValue === null ||
			Array.isArray(packageJsonValue)
		)
			throw new Error("package.json must be a JSON object.");

		const packageJson = packageJsonValue as Record<string, unknown>;
		const packageManager = packageJson.packageManager;
		if (typeof packageManager !== "string") return undefined;

		const managerName = packageManager.split("@", 1)[0];
		return managers.find(
			(candidateSpec) => candidateSpec.manager === managerName,
		)?.manager;
	},
};

/** Manifest and lockfile adapters keyed by ecosystem. */
export const ecosystemAdapters = {
	[RegistryEcosystem.NPM]: npmEcosystemAdapter,
} satisfies Record<RegistryEcosystem, EcosystemPackageManagerAdapter>;

/**
 * Deduplicate strings and sort them for stable output.
 * @param values - Values that may contain duplicates.
 * @returns Sorted unique copy.
 */
export function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Reject empty or prototype-polluting command names.
 * @param commandName - Command key from a payload or hook result.
 * @throws Error when the command name is empty or `__proto__`.
 */
function assertSafeCommandName(commandName: string): void {
	if (commandName.length === 0)
		throw new Error("Command name must not be empty.");
	if (commandName === "__proto__")
		throw new Error(`Command "${commandName}" is not allowed.`);
}

/**
 * Reject empty or argv-flag package names.
 * @param packageName - Package specifier from a payload or hook result.
 * @throws Error when the package name is empty or starts with `-`.
 */
function assertSafePackageName(packageName: string): void {
	if (packageName.length === 0)
		throw new Error("Package name must not be empty.");
	if (packageName.startsWith("-"))
		throw new Error(`Package name "${packageName}" is not allowed.`);
}

/**
 * Validate package names and combine dependency sets into unique sorted runtime/dev lists.
 * @param sets - Dependency sets to fold, in order.
 * @returns Tuple of unique sorted runtime and dev package names.
 * @throws Error when a package name is empty or starts with `-`.
 */
function uniqueValidatedDependencyLists(
	...sets: Array<RegistryDependencySet | undefined>
): [runtime: string[], dev: string[]] {
	const runtime = uniqueSorted(
		sets.flatMap(
			(dependencySet) => dependencySet?.[RegistryDependencyKind.RUNTIME] ?? [],
		),
	);
	const dev = uniqueSorted(
		sets.flatMap(
			(dependencySet) => dependencySet?.[RegistryDependencyKind.DEV] ?? [],
		),
	);
	for (const packageName of [...runtime, ...dev])
		assertSafePackageName(packageName);
	return [runtime, dev];
}

/**
 * Merge non-empty dependency lists within one ecosystem dependency set.
 * @param left - Existing merged set.
 * @param right - Set to fold in.
 * @returns Combined dependency set, or undefined when both sides are empty.
 * @throws Error when a package name is empty or starts with `-`.
 */
export function mergeDependencySet(
	left: RegistryDependencySet | undefined,
	right: RegistryDependencySet | undefined,
): RegistryDependencySet | undefined {
	const [runtime, dev] = uniqueValidatedDependencyLists(left, right);

	if (runtime.length === 0 && dev.length === 0) return undefined;

	const mergedDependencies: RegistryDependencySet = {};
	if (runtime.length > 0)
		mergedDependencies[RegistryDependencyKind.RUNTIME] = runtime;
	if (dev.length > 0) mergedDependencies[RegistryDependencyKind.DEV] = dev;
	return mergedDependencies;
}

/**
 * Merge non-empty command maps within one ecosystem.
 * Later sources overwrite earlier keys with the same name.
 * Rejects empty names, `__proto__`, and empty command strings.
 * @param left - Existing merged set.
 * @param right - Set to fold in.
 * @returns Combined command set, or undefined when both sides are empty.
 * @throws Error when a command name or value is unsafe.
 */
export function mergeCommandSet(
	left: Record<string, string> | undefined,
	right: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!left && !right) return undefined;
	const mergedCommands: Record<string, string> = {};
	for (const commandSet of [left, right]) {
		if (!commandSet) continue;
		for (const commandName of Object.keys(commandSet)) {
			assertSafeCommandName(commandName);
			const commandValue = commandSet[commandName];
			if (typeof commandValue !== "string" || commandValue.length === 0)
				throw new Error(`Command "${commandName}" must be a non-empty string.`);
			mergedCommands[commandName] = commandValue;
		}
	}
	return Object.keys(mergedCommands).length > 0 ? mergedCommands : undefined;
}

/**
 * Merge ecosystem-keyed maps by folding each ecosystem with `mergeSet`.
 * @param mergeValues - Per-ecosystem merge function.
 * @param sources - Item, pack, hook, or payload maps.
 * @returns Combined map keyed by ecosystem, or undefined when empty.
 */
export function mergeEcosystemMaps<T>(
	mergeValues: (left: T | undefined, right: T | undefined) => T | undefined,
	...sources: Array<Partial<Record<RegistryEcosystem, T>> | undefined>
): Partial<Record<RegistryEcosystem, T>> | undefined {
	const mergedByEcosystem: Partial<Record<RegistryEcosystem, T>> = {};

	for (const ecosystemMap of sources) {
		if (!ecosystemMap) continue;
		for (const ecosystem of Object.values(RegistryEcosystem)) {
			const mergedValue = mergeValues(
				mergedByEcosystem[ecosystem],
				ecosystemMap[ecosystem],
			);
			if (mergedValue !== undefined) mergedByEcosystem[ecosystem] = mergedValue;
			else Reflect.deleteProperty(mergedByEcosystem, ecosystem);
		}
	}

	return Object.keys(mergedByEcosystem).length > 0
		? mergedByEcosystem
		: undefined;
}

/**
 * Merge and dedupe repository secret name lists.
 * @param sources - Item, pack, hook, or payload secret lists.
 * @returns Sorted unique secret names, or undefined when empty.
 * @throws Error when a secret name is empty.
 */
export function mergeSecretNames(
	...sources: Array<string[] | undefined>
): string[] | undefined {
	const secretNames = new Set<string>();
	for (const sourceNames of sources) {
		if (!sourceNames) continue;
		for (const secretName of sourceNames) {
			if (secretName.length === 0)
				throw new Error("Secret name must not be empty.");
			secretNames.add(secretName);
		}
	}
	if (secretNames.size === 0) return undefined;
	return [...secretNames].sort((left, right) => left.localeCompare(right));
}

/**
 * Build a compiled item, omitting absent optional fields.
 * @param parts - Files plus optional deps, commands, and secrets.
 * @returns Compiled item with undefined optionals dropped.
 */
export function compiledItem(parts: {
	files: CompiledItemFile[];
	dependencies?: RegistryEcosystemDependencies;
	commands?: RegistryEcosystemCommands;
	secrets?: string[];
}): CompiledItem {
	return {
		files: parts.files,
		...(parts.dependencies ? { dependencies: parts.dependencies } : {}),
		...(parts.commands ? { commands: parts.commands } : {}),
		...(parts.secrets ? { secrets: parts.secrets } : {}),
	};
}

/**
 * Reject a file target that is empty or escapes the project root.
 * @param target - Compiled item file target.
 * @throws Error when the target is empty or not a safe relative path.
 */
function assertSafeFileTarget(target: string): void {
	if (target.length === 0)
		throw new Error(
			"Compiled item file target must be a non-empty relative path.",
		);
	if (isEscapingRelativePath(target))
		throw new Error(
			`Compiled item file target "${target}" must be a relative path (no absolute paths, URLs, or "..").`,
		);
}

/**
 * Fail when two compiled item files share the same install target.
 * @param files - Combined file list.
 * @param messageForTarget - Error message for a duplicate target.
 * @throws Error when a target is unsafe or appears more than once.
 */
export function assertUniqueCompiledItemTargets(
	files: CompiledItemFile[],
	messageForTarget: (target: string) => string,
): void {
	const seen = new Set<string>();
	for (const file of files) {
		assertSafeFileTarget(file.target);
		if (seen.has(file.target)) throw new Error(messageForTarget(file.target));
		seen.add(file.target);
	}
}

/** Manifest fields folded across compiled items, raw items, or packs. */
export type CompiledItemFields = Pick<
	CompiledItem,
	"dependencies" | "commands" | "secrets"
>;

/**
 * Merge deps, commands, and secrets from compiled items or raw item/pack manifests.
 * @param items - Sources to fold in order.
 * @returns Merged optional fields, omitted when empty.
 */
export function mergeCompiledItemFields(
	...items: Array<CompiledItemFields | undefined>
): CompiledItemFields {
	const dependencies = mergeEcosystemMaps(
		mergeDependencySet,
		...items.map((item) => item?.dependencies),
	);
	const commands = mergeEcosystemMaps(
		mergeCommandSet,
		...items.map((item) => item?.commands),
	);
	const secrets = mergeSecretNames(...items.map((item) => item?.secrets));
	return {
		...(dependencies ? { dependencies } : {}),
		...(commands ? { commands } : {}),
		...(secrets ? { secrets } : {}),
	};
}

/**
 * Fold files so a repeated target only fails when its content differs.
 * The build inlines item-level files into pack payloads, so install-time
 * folding of a base payload plus its pack must tolerate identical repeats.
 * @param files - Combined file list in fold order.
 * @param messageForTarget - Error for a colliding file target.
 * @returns Files with exact-duplicate targets dropped (first occurrence wins).
 * @throws Error when a target repeats with different content or is unsafe.
 */
function dedupeCompiledItemFiles(
	files: CompiledItemFile[],
	messageForTarget: (target: string) => string,
): CompiledItemFile[] {
	for (const file of files) assertSafeFileTarget(file.target);
	const byTarget = new Map<string, string>();
	for (const file of files) {
		const existingContent = byTarget.get(file.target);
		if (existingContent === undefined) {
			byTarget.set(file.target, file.content);
			continue;
		}
		if (existingContent !== file.content)
			throw new Error(messageForTarget(file.target));
	}
	const seen = new Set<string>();
	return files.filter((file) => {
		if (seen.has(file.target)) return false;
		seen.add(file.target);
		return true;
	});
}

/**
 * Concatenate files and merge deps/commands/secrets from compiled items.
 * @param items - Payloads to fold in order (base first).
 * @param duplicateTargetMessage - Error for a conflicting file target.
 * @returns Folded compiled item.
 * @throws Error when two files share a target with different content.
 */
export function foldCompiledItems(
	items: CompiledItem[],
	duplicateTargetMessage: (target: string) => string,
): CompiledItem {
	const files = dedupeCompiledItemFiles(
		items.flatMap((item) => item.files),
		duplicateTargetMessage,
	);
	return compiledItem({ files, ...mergeCompiledItemFields(...items) });
}

/**
 * Reserved Mustache keys for an ecosystem: `packageManager` plus that spec's `pm*` bindings.
 * @param ecosystem - Registry ecosystem whose manager bindings to reserve.
 * @returns Key names that option and hook bindings must not reuse.
 */
export function reservedInterpolationKeys(
	ecosystem: RegistryEcosystem = RegistryEcosystem.NPM,
): string[] {
	const fallbackManagerSpec = ecosystemManagers[ecosystem][0];
	/* v8 ignore next — every registered ecosystem declares at least one manager */
	if (!fallbackManagerSpec) return [PACKAGE_MANAGER_KEY];
	return [
		PACKAGE_MANAGER_KEY,
		...Object.keys(
			packageManagerBindings(ecosystem, fallbackManagerSpec.manager),
		),
	];
}

/**
 * Interpolation bindings for a selected package manager, derived from its spec fragments.
 * @param ecosystem - Registry ecosystem that owns the manager.
 * @param manager - Selected package manager.
 * @returns Mustache bindings (`pmRun`, `pmExec`, `pmInstall`, `pmInstallCi`, `pmPublish`).
 * @throws Error when the manager is not valid for the ecosystem.
 */
export function packageManagerBindings(
	ecosystem: RegistryEcosystem,
	manager: RegistryPackageManager,
): PackageManagerBindings {
	const spec = packageManagerSpec(ecosystem, manager);
	return {
		pmRun: [spec.manager, ...spec.run].join(" "),
		pmExec: [spec.manager, ...spec.exec].join(" "),
		pmInstall: [spec.manager, ...spec.installRegular].join(" "),
		pmInstallCi: [spec.manager, ...spec.installCi].join(" "),
		pmPublish: [spec.manager, ...spec.publish].join(" "),
	};
}

/**
 * Whether compiled item files interpolate this ecosystem's package-manager bindings.
 * @param compiledItem - Compiled item whose file templates are scanned.
 * @param ecosystem - Registry ecosystem whose binding keys to look for.
 * @returns True when a Mustache tag for the manager or its `pm*` bindings appears.
 */
function compiledItemInterpolatesPackageManager(
	compiledItem: CompiledItem,
	ecosystem: RegistryEcosystem,
): boolean {
	// Reserved keys are exactly `packageManager` + the ecosystem's `pm*` bindings.
	const reservedKeys = reservedInterpolationKeys(ecosystem);
	const mustacheTagPattern = new RegExp(
		String.raw`\{\{\s*(?:${reservedKeys.join("|")})\s*\}\}`,
	);
	return compiledItem.files.some((file) =>
		mustacheTagPattern.test(file.content),
	);
}

/**
 * Whether a compiled item needs a package manager for an ecosystem.
 * @param compiledItem - Compiled item from the install plan or a beforeWrite hook.
 * @param ecosystem - Registry ecosystem to check.
 * @returns True when that ecosystem appears on deps, commands, or interpolated files.
 */
export function compiledItemUsesEcosystem(
	compiledItem: CompiledItem,
	ecosystem: RegistryEcosystem,
): boolean {
	const ecosystemDependencies = compiledItem.dependencies?.[ecosystem];
	const ecosystemCommands = compiledItem.commands?.[ecosystem];
	const hasDependencies =
		(ecosystemDependencies?.[RegistryDependencyKind.RUNTIME]?.length ?? 0) >
			0 ||
		(ecosystemDependencies?.[RegistryDependencyKind.DEV]?.length ?? 0) > 0;
	const hasCommands =
		ecosystemCommands !== undefined &&
		Object.keys(ecosystemCommands).length > 0;
	return (
		hasDependencies ||
		hasCommands ||
		compiledItemInterpolatesPackageManager(compiledItem, ecosystem)
	);
}

/**
 * Select a package manager for one ecosystem: lockfile when unambiguous, otherwise prompt.
 * @param ecosystem - Registry ecosystem to select for.
 * @param projectDir - Absolute project root.
 * @param prompt - Prompt host used when lockfile detection is inconclusive.
 * @param pathExists - Existence checker for absolute paths. Defaults to `fs.existsSync`.
 * @returns Selected manager for that ecosystem.
 */
export async function selectPackageManager(
	ecosystem: RegistryEcosystem,
	projectDir: string,
	prompt: Pick<PromptHost, "select">,
	pathExists: (absolutePath: string) => boolean = fs.existsSync,
): Promise<RegistryPackageManager> {
	const managerSpecs = ecosystemManagers[ecosystem];
	const adapter = ecosystemAdapters[ecosystem];
	const declaredManager = await adapter.detectFromManifest(
		projectDir,
		managerSpecs,
		pathExists,
	);
	if (declaredManager) return declaredManager;

	const lockfileMatch = adapter.detectFromLockfiles(
		projectDir,
		managerSpecs,
		pathExists,
	);
	if (lockfileMatch) return lockfileMatch.manager;

	const selectedManager = await prompt.select(
		"Which package manager should be used for the project?",
		{
			options: managerSpecs.map((managerSpec) => ({
				label: managerSpec.label,
				value: managerSpec.manager,
			})),
		},
		managerSpecs[0].manager,
	);

	if (!isPackageManagerForEcosystem(ecosystem, selectedManager))
		throw new Error(
			`Unknown packageManager "${selectedManager}". Expected one of: ${managerSpecs.map((managerSpec) => managerSpec.manager).join(", ")}.`,
		);

	return selectedManager;
}

/**
 * Build argv install commands for a chosen ecosystem manager.
 * @param ecosystem - Registry ecosystem for the packages.
 * @param manager - Selected package manager.
 * @param dependencySet - Runtime and dev packages to install.
 * @returns Install commands to run, or an empty list when there is nothing to install.
 * @throws Error when `manager` is not valid for `ecosystem`, or a package name is unsafe.
 */
export function buildPackageInstallCommands(
	ecosystem: RegistryEcosystem,
	manager: RegistryPackageManager,
	dependencySet: RegistryDependencySet,
): PackageInstallCommand[] {
	// Dedupe, validate, and sort so generated command strings are stable across payloads.
	const [runtime, dev] = uniqueValidatedDependencyLists(dependencySet);
	if (runtime.length === 0 && dev.length === 0) return [];

	const managerSpec = packageManagerSpec(ecosystem, manager);
	const commands: PackageInstallCommand[] = [];

	const addInstallCommand = (
		dependencyKind: RegistryDependencyKind,
		packageNames: string[],
	): void => {
		if (packageNames.length === 0) return;
		const args = [...managerSpec.install[dependencyKind], ...packageNames];
		commands.push({
			executable: managerSpec.manager,
			args,
			display: [managerSpec.manager, ...args].join(" "),
		});
	};

	addInstallCommand(RegistryDependencyKind.RUNTIME, runtime);
	addInstallCommand(RegistryDependencyKind.DEV, dev);
	return commands;
}
