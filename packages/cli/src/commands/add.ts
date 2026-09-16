import {
	assumeContextFromSelectedItems,
	buildInstallPlan,
	buildInterpolationContext,
	type CompiledItem,
	catalogNeedsPackageManager,
	collectRegistryDependencies,
	compiledItem,
	compiledItemUsesEcosystem,
	foldCompiledItems,
	type HandlerRuntime,
	type IndexEntry,
	type IndexItem,
	type InstallNode,
	interpolateCompiledItem,
	mergeSecretNames,
	packageManagerDropsCandidateDependsOn,
	type Registry,
	type RegistryConditionValue,
	type RegistryContext,
	RegistryEcosystem,
	type RegistryPackageManager,
	runAfterInstallHook,
	runBeforeWriteHook,
	runInstallHookOptions,
	selectPackageManager,
	setScriptExecutor,
	uniqueKnownRegistryItems,
} from "@pebbles/core";
import chalk from "chalk";
import { defaultText, primaryText } from "../cli/labels";
import { groupedMultiselectInput, selectInput } from "../cli/prompts";
import { runWithTasks, task, taskGroup } from "../cli/tasks";
import {
	captureItemLocalConditionsForPlan,
	captureRequiredConditions,
} from "../utils/conditions";
import {
	confirmFileOverwrites,
	type PlannedItemWrites,
	planFileWrites,
	writePlannedFile,
} from "../utils/files";
import {
	installDeclaredPackages,
	mergeProjectCommands,
} from "../utils/packages";
import { loadCompiledItems } from "../utils/registry";
import { prepareScriptExecution, projectScriptHelpers } from "../utils/scripts";

/** Options accepted by the add command. */
interface AddCommandOptions {
	/** Registry items (`id` or `id@pack`) from positional arguments. */
	items?: string[];
	/** Overwrite existing files without prompting. */
	overwrite?: boolean;
}

/** Parsed payload paired with the display label used in install progress. */
interface PreparedInstallItem {
	/** Human-readable item title for task output. */
	label: string;
	/** Validated compiled item. */
	compiledItem: CompiledItem;
}

/** Prepared install item paired with its install-plan node. */
interface InstallPlanItem extends PreparedInstallItem {
	/** Install node from the plan. */
	node: InstallNode;
}

/** Where an interpolation option-value list was first recorded. */
type InterpolationOptionOwner =
	| { readonly kind: "shared" }
	| { readonly kind: "item"; readonly itemId: string };

/**
 * Prompt for registry items in one list grouped by type when none were provided on the command line.
 * @param registry - Loaded registry.
 * @returns Selected item ids.
 */
async function promptForItems(registry: Registry): Promise<string[]> {
	const items = Object.entries(registry.items);
	if (items.length === 0) throw new Error("No registry items are available.");

	// Core's parse-time validation guarantees every item type is declared, so grouping over declared types covers each item at most once.
	const options = Object.fromEntries(
		Object.keys(registry.types).flatMap((type) => {
			const group = items
				.filter(([, item]) => item.type === type)
				.sort(([, a], [, b]) => a.title.localeCompare(b.title))
				.map(([id, item]) => ({
					label: item.title,
					value: id,
					hint: item.description,
				}));
			return group.length > 0
				? [[registry.types[type].label, group] as const]
				: [];
		}),
	);

	const selected = await groupedMultiselectInput(
		"Which registry items should be added?",
		options,
	);

	if (selected.length === 0)
		throw new Error("Select at least one registry item to add.");

	return selected;
}

/**
 * Look up a catalog item named by the install plan.
 * @param registry - Loaded registry.
 * @param itemId - Plan node item id.
 * @returns Catalog item for that id.
 * @throws Error when the plan names an item that is not in the registry.
 */
function registryItemForInstall(registry: Registry, itemId: string): IndexItem {
	const item = registry.items[itemId];
	if (item === undefined)
		throw new Error(
			`Install plan references unknown registry item "${itemId}".`,
		);
	return item;
}

/**
 * Fail when the install plan is empty or names an item missing from the registry.
 * @param plan - Ordered install nodes.
 * @param registry - Loaded registry.
 * @throws Error when nothing would install, or a node is unknown.
 */
function assertInstallPlan(plan: InstallNode[], registry: Registry): void {
	if (plan.length === 0)
		throw new Error("No registry items were selected for installation.");
	for (const node of plan) registryItemForInstall(registry, node.itemId);
}

/**
 * Merge one or more compiled items for a single install node.
 * @param itemId - Registry item id for error messages.
 * @param sources - Compiled item URIs selected for this node.
 * @param compiledItemDocuments - Parsed compiled items keyed by source URI.
 * @returns Merged payload (files concatenated; deps/commands/secrets folded).
 * @throws Error when a planned source is missing or targets collide.
 */
function mergeCompiledItemSources(
	itemId: string,
	sources: string[],
	compiledItemDocuments: Map<string, CompiledItem>,
): CompiledItem {
	const payloads: CompiledItem[] = [];

	for (const source of sources) {
		const payload = compiledItemDocuments.get(source);
		if (payload === undefined)
			throw new Error(
				`Missing compiled item for registry item "${itemId}" (${source}).`,
			);
		payloads.push(payload);
	}

	return foldCompiledItems(
		payloads,
		(target) =>
			`Registry item "${itemId}" has duplicate compiled item target "${target}".`,
	);
}

/**
 * Fold fetched compiled items into labeled install units.
 * @param planItems - Ordered install nodes from the install plan.
 * @param registry - Loaded registry for display titles.
 * @param compiledItemDocuments - Parsed compiled items keyed by source URI.
 * @returns Prepared items ready for lifecycle scripts, overwrite checks, and writes.
 * @throws Error when a planned source is missing from the fetched documents.
 */
function prepareInstallItems(
	planItems: InstallNode[],
	registry: Registry,
	compiledItemDocuments: Map<string, CompiledItem>,
): InstallPlanItem[] {
	return planItems.map((node) => {
		const item = registryItemForInstall(registry, node.itemId);
		const label = item.title || node.itemId;
		const sources = node.sources ?? [];

		if (sources.length === 0)
			return {
				label,
				node,
				compiledItem: compiledItem({ files: [] }),
			};

		return {
			label,
			node,
			compiledItem: mergeCompiledItemSources(
				node.itemId,
				sources,
				compiledItemDocuments,
			),
		};
	});
}

/**
 * Apply a beforeWrite-hook snapshot as the working compiled item.
 * Omitted optional fields stay absent (they are not wiped to `undefined`).
 * @param hookResult - Merged hook output from core.
 * @param bindings - Shared bindings map mutated in place.
 * @returns Payload ready for the next beforeWrite script or confirm.
 */
function compiledItemFromBeforeWriteHook(
	hookResult: Awaited<ReturnType<typeof runBeforeWriteHook>>,
	bindings: Record<string, string>,
): CompiledItem {
	Object.assign(bindings, hookResult.bindings);
	return compiledItem({
		files: hookResult.files,
		commands: hookResult.commands,
		dependencies: hookResult.dependencies,
		secrets: hookResult.secrets,
	});
}

/**
 * Run `beforeWrite` scripts for install items in plan order.
 * @param indexLocation - Absolute path or HTTPS URL of the index document.
 * @param runtime - Shared handler runtime.
 * @param conditions - Resolved condition context.
 * @param packageManager - Selected package manager, if any.
 * @param installItems - Prepared install items with plan nodes.
 * @returns Updated items and merged bindings.
 */
async function runBeforeWriteScripts(
	indexLocation: string,
	runtime: HandlerRuntime,
	conditions: RegistryContext,
	packageManager: RegistryPackageManager | undefined,
	installItems: InstallPlanItem[],
): Promise<{ items: InstallPlanItem[]; bindings: Record<string, string> }> {
	const bindings: Record<string, string> = {};
	const result: InstallPlanItem[] = [];

	for (const item of installItems) {
		let payload = item.compiledItem;
		for (const scriptUri of item.node.beforeWriteScripts ?? []) {
			payload = compiledItemFromBeforeWriteHook(
				await runBeforeWriteHook(
					indexLocation,
					scriptUri,
					runtime,
					runInstallHookOptions(item.node, {
						conditions,
						packageManager,
						bindings,
						compiledItem: payload,
					}),
				),
				bindings,
			);
		}

		result.push({ ...item, compiledItem: payload });
	}

	return { items: result, bindings };
}

/**
 * Write prepared files with one progress tree: items as groups, files as subtasks.
 * @param plannedItems - Items that have files to write.
 */
async function writePreparedItems(
	plannedItems: PlannedItemWrites[],
): Promise<void> {
	if (plannedItems.length === 0) return;

	await runWithTasks(
		"Adding item content",
		plannedItems.map((item) =>
			taskGroup(
				primaryText(item.label),
				item.files.map((file) =>
					task(primaryText(file.target), async () => {
						await writePlannedFile(file);
					}),
				),
			),
		),
	);
}

/**
 * Whether two select option lists differ in value, label, or bindings.
 * @param left - First option list.
 * @param right - Second option list.
 * @returns True when the lists are not equivalent.
 */
function interpolationOptionValueListsDiffer(
	left: RegistryConditionValue[],
	right: RegistryConditionValue[],
): boolean {
	if (left === right) return false;
	if (left.length !== right.length) return true;
	return left.some((entry, index) => {
		const other = right[index];
		if (entry.value !== other?.value || entry.label !== other?.label)
			return true;
		const leftBindings = entry.bindings ?? {};
		const rightBindings = other.bindings ?? {};
		const leftKeys = Object.keys(leftBindings);
		return (
			leftKeys.length !== Object.keys(rightBindings).length ||
			leftKeys.some((key) => leftBindings[key] !== rightBindings[key])
		);
	});
}

/**
 * Label an option-value owner for conflict errors.
 * @param owner - Shared catalog or a registry item id.
 * @returns Human-readable owner.
 */
function formatInterpolationOptionOwner(
	owner: InterpolationOptionOwner,
): string {
	switch (owner.kind) {
		case "shared":
			return "shared conditions";
		case "item":
			return `"${owner.itemId}"`;
		/* v8 ignore start */
		// Stryker disable all: unreachable exhaustive default
		default: {
			const _exhaustive: never = owner;
			return _exhaustive;
		}
		// Stryker restore all
		/* v8 ignore stop */
	}
}

/**
 * Record select option lists, failing when the same key has two different lists.
 * @param options - Option lists keyed by condition name.
 * @param owners - First owner recorded for each key.
 * @param key - Condition name.
 * @param values - Option list to record, if any.
 * @param owner - Shared catalog or item that declared the list.
 * @throws Error when an existing list conflicts with `values`.
 */
function assignInterpolationOptionValues(
	options: Record<string, RegistryConditionValue[]>,
	owners: Map<string, InterpolationOptionOwner>,
	key: string,
	values: RegistryConditionValue[] | undefined,
	owner: InterpolationOptionOwner,
): void {
	if (!values) return;
	const existing = options[key];
	if (
		existing !== undefined &&
		interpolationOptionValueListsDiffer(existing, values)
	) {
		const previous = owners.get(key) ?? /* v8 ignore next */ owner;
		throw new Error(
			`Condition "${key}" declares conflicting interpolation option values (${formatInterpolationOptionOwner(previous)} and ${formatInterpolationOptionOwner(owner)}).`,
		);
	}
	options[key] = values;
	if (!owners.has(key)) owners.set(key, owner);
}

/**
 * Collect select option lists from shared and item-local conditions on the plan.
 * @param registry - Loaded registry.
 * @param plan - Ordered install nodes.
 * @returns Options keyed by condition name.
 * @throws Error when a plan item is unknown or two sources disagree on a key's values.
 */
function interpolationOptionValues(
	registry: Registry,
	plan: InstallNode[],
): Record<string, RegistryConditionValue[]> {
	const options: Record<string, RegistryConditionValue[]> = {};
	const owners = new Map<string, InterpolationOptionOwner>();
	for (const [key, condition] of Object.entries(registry.conditions ?? {})) {
		assignInterpolationOptionValues(options, owners, key, condition.values, {
			kind: "shared",
		});
	}
	for (const node of plan) {
		const item = registryItemForInstall(registry, node.itemId);
		for (const [key, condition] of Object.entries(item.conditions ?? {})) {
			assignInterpolationOptionValues(options, owners, key, condition.values, {
				kind: "item",
				itemId: node.itemId,
			});
		}
	}
	return options;
}

/**
 * Print one numbered next-step with a bulleted list.
 * @param step - 1-based step number.
 * @param title - Step title printed before a colon.
 * @param values - Lines listed under the step.
 */
function printNextStepList(
	step: number,
	title: string,
	values: string[],
): void {
	console.log(`  ${step}. ${title}:`);
	for (const value of values) console.log(`     - ${primaryText(value)}`);
}

/**
 * Print numbered Next steps for pending installs and repository secrets.
 * @param pendingInstallCommands - Package install commands still left for the user.
 * @param secrets - Repository secret names to configure manually, if any.
 */
function printInstallNextSteps(
	pendingInstallCommands: string[],
	secrets: string[] | undefined,
): void {
	if (pendingInstallCommands.length === 0 && (secrets?.length ?? 0) === 0)
		return;

	console.log();
	console.log(chalk.bold("Next steps"));
	let step = 1;
	if (pendingInstallCommands.length > 0) {
		printNextStepList(step, "Install dependencies", pendingInstallCommands);
		step += 1;
	}
	if (secrets && secrets.length > 0)
		printNextStepList(
			step,
			"Configure the following repository secrets in GitHub",
			secrets,
		);
}

/**
 * Select a package manager when the catalog or compiled payload needs one.
 * @param ecosystem - Registry ecosystem to select for.
 * @param projectDir - Absolute project root.
 * @param needed - Whether a manager is required for this install.
 * @returns Selected manager, or undefined when the install does not use the ecosystem.
 */
async function selectPackageManagerWhenNeeded(
	ecosystem: RegistryEcosystem,
	projectDir: string,
	needed: boolean,
): Promise<RegistryPackageManager | undefined> {
	if (!needed) return undefined;
	return selectPackageManager(ecosystem, projectDir, {
		select: selectInput,
	});
}

/**
 * Select a package manager when any payload uses the npm ecosystem.
 * @param projectDir - Absolute project root.
 * @param items - Prepared install items to scan.
 * @returns Selected manager, or undefined when no payload uses npm.
 */
async function selectPackageManagerForItems(
	projectDir: string,
	items: Array<{ compiledItem: CompiledItem }>,
): Promise<RegistryPackageManager | undefined> {
	return selectPackageManagerWhenNeeded(
		RegistryEcosystem.NPM,
		projectDir,
		items.some((item) =>
			compiledItemUsesEcosystem(item.compiledItem, RegistryEcosystem.NPM),
		),
	);
}

/**
 * Walk the candidate graph and select a package manager when pack `when` needs one.
 * Re-walks only when the selected manager can drop pack-level `dependsOn`.
 * @param items - Selected item tokens.
 * @param registry - Loaded registry.
 * @param projectDir - Absolute project root.
 * @returns Candidate entries, optional package manager, and pin-derived context.
 */
async function candidateEntriesWithPackageManager(
	items: string[],
	registry: Registry,
	projectDir: string,
): Promise<{
	candidateEntries: IndexEntry[];
	packageManager: RegistryPackageManager | undefined;
	pinContext: RegistryContext;
}> {
	const pinContext = assumeContextFromSelectedItems(
		items,
		registry.items,
		registry.conditions,
	);
	let candidateEntries = collectRegistryDependencies(
		items,
		registry.items,
		pinContext,
	);
	const packageManager = await selectPackageManagerWhenNeeded(
		RegistryEcosystem.NPM,
		projectDir,
		catalogNeedsPackageManager(candidateEntries, registry.conditions),
	);
	// If a package manager is selected and the presence of a package manager drops pack-level `dependsOn`, re-collect the dependencies with the package manager.
	if (
		packageManager !== undefined &&
		packageManagerDropsCandidateDependsOn(
			candidateEntries,
			items,
			pinContext,
			packageManager,
		)
	)
		candidateEntries = collectRegistryDependencies(
			items,
			registry.items,
			pinContext,
			packageManager,
		);

	return { candidateEntries, packageManager, pinContext };
}

/**
 * Finalize installed items after file writes and dependency handling complete.
 * @param indexLocation - Absolute path or HTTPS URL of the index document.
 * @param runtime - Shared handler runtime.
 * @param conditions - Captured condition context.
 * @param packageManager - Selected package manager, if any.
 * @param bindings - Bindings from beforeWrite hooks.
 * @param installItems - Interpolated install items.
 */
async function finalizeInstalledItems(
	indexLocation: string,
	runtime: HandlerRuntime,
	conditions: RegistryContext,
	packageManager: RegistryPackageManager | undefined,
	bindings: Record<string, string>,
	installItems: InstallPlanItem[],
): Promise<void> {
	const itemsWithScripts = installItems.flatMap((item) => {
		const scripts = item.node.afterInstallScripts;
		return scripts && scripts.length > 0 ? [{ item, scripts }] : [];
	});
	if (itemsWithScripts.length === 0) return;

	await runWithTasks(
		"Finishing setup",
		itemsWithScripts.map(({ item, scripts }) =>
			task(primaryText(item.label), async () => {
				for (const scriptUri of scripts) {
					await runAfterInstallHook(
						indexLocation,
						scriptUri,
						runtime,
						runInstallHookOptions(item.node, {
							conditions,
							packageManager,
							bindings,
							compiledItem: item.compiledItem,
						}),
					);
				}
			}),
		),
	);
}

/**
 * Install registry items into the current project directory.
 * @param registry - Loaded registry.
 * @param indexLocation - Absolute path or HTTPS URL of the index document.
 * @param options - Add command options.
 */
export async function addCommand(
	registry: Registry,
	indexLocation: string,
	options: AddCommandOptions = {},
): Promise<void> {
	const projectDir = process.cwd();
	const selected =
		options.items && options.items.length > 0
			? options.items
			: await promptForItems(registry);
	const items = uniqueKnownRegistryItems(selected, registry.items);

	try {
		let { candidateEntries, packageManager, pinContext } =
			await candidateEntriesWithPackageManager(items, registry, projectDir);

		const runtime = projectScriptHelpers(projectDir);
		const { allowInfer } = await prepareScriptExecution({
			indexLocation,
			registry,
			itemIds: candidateEntries.map((entry) => entry.itemId),
			selectedItems: items,
			projectDir,
			context: pinContext,
			packageManager,
		});

		let conditions = await captureRequiredConditions(
			registry,
			indexLocation,
			projectDir,
			items,
			{
				runtime,
				packageManager,
				allowInfer,
				context: pinContext,
			},
		);

		let plan = buildInstallPlan(
			items,
			registry.items,
			conditions,
			packageManager,
		);
		assertInstallPlan(plan, registry);

		({ context: conditions, plan } = await captureItemLocalConditionsForPlan(
			registry,
			indexLocation,
			items,
			plan,
			conditions,
			runtime,
			{ packageManager, allowInfer },
		));
		assertInstallPlan(plan, registry);

		console.log();

		const sources = plan.flatMap((node) => node.sources ?? []);
		let compiledItemDocuments = new Map<string, CompiledItem>();
		if (sources.length > 0)
			await runWithTasks("Preparing changes", async () => {
				compiledItemDocuments = await loadCompiledItems(
					indexLocation,
					sources,
					registry.itemIntegrity,
				);
			});
		const preparedItems = prepareInstallItems(
			plan,
			registry,
			compiledItemDocuments,
		);

		packageManager ??= await selectPackageManagerForItems(
			projectDir,
			preparedItems,
		);

		const { items: afterHooks, bindings } = await runBeforeWriteScripts(
			indexLocation,
			runtime,
			conditions,
			packageManager,
			preparedItems,
		);

		packageManager ??= await selectPackageManagerForItems(
			projectDir,
			afterHooks,
		);

		const interpolationValues = buildInterpolationContext({
			conditions,
			hookBindings: bindings,
			optionValues: interpolationOptionValues(registry, plan),
			...(packageManager && {
				packageManager,
				ecosystem: RegistryEcosystem.NPM,
			}),
		});
		const installItems = afterHooks.map((item) => ({
			...item,
			compiledItem: interpolateCompiledItem(
				item.compiledItem,
				interpolationValues,
			),
		}));

		const fileWrites = await planFileWrites(projectDir, installItems);
		await confirmFileOverwrites(
			fileWrites.conflicts,
			options.overwrite === true,
		);

		await writePreparedItems(fileWrites.items);

		await mergeProjectCommands(
			projectDir,
			installItems.map((item) => item.compiledItem),
			options.overwrite === true,
		);

		const pendingInstallCommands =
			packageManager === undefined
				? []
				: await installDeclaredPackages(
						installItems.flatMap((item) =>
							item.compiledItem.dependencies
								? [item.compiledItem.dependencies]
								: [],
						),
						projectDir,
						packageManager,
					);

		await finalizeInstalledItems(
			indexLocation,
			runtime,
			conditions,
			packageManager,
			bindings,
			installItems,
		);

		const itemWord = installItems.length === 1 ? "item" : "items";
		console.log();
		console.log(defaultText(`Installed ${installItems.length} ${itemWord}.`));

		const secrets = mergeSecretNames(
			...installItems.map((item) => item.compiledItem.secrets),
		);
		printInstallNextSteps(pendingInstallCommands, secrets);

		console.log();
	} finally {
		setScriptExecutor(undefined);
	}
}
