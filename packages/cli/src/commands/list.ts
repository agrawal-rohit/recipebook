import {
	type IndexItem,
	RESERVED_CATALOG_TYPE_KEY,
	type Registry,
	type RegistryItemTypeDefinition,
} from "@pebbles/core";
import chalk from "chalk";
import { defaultText, primaryText } from "../cli/labels";
import { multiselectInput } from "../cli/prompts";

/** Explicit CAC `--type` value: a string, or `string[]` when the flag is repeated. */
type ExplicitTypeFilterOption = string | string[];

/** Raw CAC `--type` value, omitted when the flag is not passed. */
type TypeFilterOption = ExplicitTypeFilterOption | undefined;

/**
 * Split CAC `--type` values into trimmed tokens.
 * @param typeOption - A string, or `string[]` when the flag is repeated.
 * @returns Individual type tokens from comma-separated entries.
 */
function splitTypeTokens(typeOption: ExplicitTypeFilterOption): string[] {
	const parts = typeof typeOption === "string" ? [typeOption] : typeOption;
	return parts.flatMap((part) =>
		part
			.split(",")
			.map((token) => token.trim())
			.filter(Boolean),
	);
}

/**
 * Ensure every requested type exists in the registry.
 * @param requestedTypes - Explicit type tokens (excluding `all`).
 * @param availableTypes - Types present in the registry.
 * @throws When a requested type is unsupported.
 */
function assertRequestedTypesSupported(
	requestedTypes: string[],
	availableTypes: string[],
): void {
	const available = new Set(availableTypes);
	for (const type of requestedTypes) {
		if (!available.has(type))
			throw new Error(
				`Unsupported registry type "${type}" (available: ${availableTypes.join(", ")}).`,
			);
	}
}

/**
 * Look up display metadata for a catalog type.
 * @param type - Type key from `registry.types`.
 * @param typeMeta - Display metadata keyed by type value.
 * @returns Type definition for `type`.
 * @throws Error when the type is missing from `typeMeta`.
 */
function typeDefinition(
	type: string,
	typeMeta: Record<string, RegistryItemTypeDefinition>,
): RegistryItemTypeDefinition {
	const meta = typeMeta[type];
	if (!meta) throw new Error(`Registry item type "${type}" is not declared.`);
	return meta;
}

/**
 * Fail when the catalog uses the reserved `--type all` sentinel as a type key.
 * @param availableTypes - Types present in the registry.
 * @throws Error when `"all"` is a catalog type.
 */
function assertAllIsNotACatalogType(availableTypes: string[]): void {
	if (availableTypes.includes(RESERVED_CATALOG_TYPE_KEY))
		throw new Error(
			`Registry item type "${RESERVED_CATALOG_TYPE_KEY}" is reserved for the --type ${RESERVED_CATALOG_TYPE_KEY} filter.`,
		);
}

/**
 * Fail when an item's type is not in the catalog.
 * @param registry - Registry whose items are about to be listed.
 * @throws Error when an item type is undeclared.
 */
function assertItemTypesDeclared(registry: Registry): void {
	for (const [itemId, item] of Object.entries(registry.items)) {
		if (!(item.type in registry.types))
			throw new Error(
				`Registry item "${itemId}" has undeclared type "${item.type}".`,
			);
	}
}

/**
 * Parse which item types to include from `--type`.
 * @param typeOption - CAC `--type` value: a string, or `string[]` when the flag is repeated.
 * @param availableTypes - Types present in the registry.
 * @returns Allowed item types.
 */
function parseTypeFilter(
	typeOption: ExplicitTypeFilterOption,
	availableTypes: string[],
): Set<string> {
	const tokens = splitTypeTokens(typeOption);
	if (tokens.length === 0)
		throw new Error("--type requires at least one type value.");

	const wantsAll = tokens.includes(RESERVED_CATALOG_TYPE_KEY);
	const requestedTypes = tokens.filter(
		(token) => token !== RESERVED_CATALOG_TYPE_KEY,
	);

	if (wantsAll && requestedTypes.length > 0)
		throw new Error(
			`Cannot combine type "${RESERVED_CATALOG_TYPE_KEY}" with specific --type values.`,
		);

	if (wantsAll) return new Set(availableTypes);

	assertRequestedTypesSupported(requestedTypes, availableTypes);
	return new Set(requestedTypes);
}

/**
 * Build multiselect options for registry item types.
 * @param availableTypes - Types present in the registry.
 * @param typeMeta - Display metadata keyed by type value.
 * @returns Options for a type multiselect prompt.
 */
function typeSelectOptions(
	availableTypes: string[],
	typeMeta: Record<string, RegistryItemTypeDefinition>,
): Array<{ label: string; value: string; hint?: string }> {
	return availableTypes.map((type) => {
		const meta = typeDefinition(type, typeMeta);
		return {
			label: meta.label ?? type,
			value: type,
			...(meta.description ? { hint: meta.description } : {}),
		};
	});
}

/**
 * Prompt for item types when `--type` is omitted.
 * @param availableTypes - Types present in the registry.
 * @param typeMeta - Display metadata keyed by type value.
 * @returns Selected type values.
 * @throws When no types are selected.
 */
async function promptTypeFilter(
	availableTypes: string[],
	typeMeta: Record<string, RegistryItemTypeDefinition>,
): Promise<Set<string>> {
	const selected = await multiselectInput(
		"Which item types should be listed?",
		{ options: typeSelectOptions(availableTypes, typeMeta) },
		availableTypes,
	);

	if (selected.length === 0)
		throw new Error("Select at least one item type to list.");

	return new Set(selected);
}

/**
 * Resolve allowed item types from `--type` or an interactive prompt.
 * @param typeOption - CAC `--type` value: a string, or `string[]` when repeated.
 * @param availableTypes - Types present in the registry.
 * @param typeMeta - Display metadata keyed by type value.
 * @returns Allowed item types.
 */
async function typeFilterFromOption(
	typeOption: TypeFilterOption,
	availableTypes: string[],
	typeMeta: Record<string, RegistryItemTypeDefinition>,
): Promise<Set<string>> {
	if (availableTypes.length === 0)
		throw new Error("No registry item types found.");

	if (typeOption === undefined)
		return promptTypeFilter(availableTypes, typeMeta);

	return parseTypeFilter(typeOption, availableTypes);
}

/**
 * Group registry items by their type value.
 * @param matches - Items to group.
 * @returns Items keyed by type.
 */
function groupItemsByType(matches: IndexItem[]): Map<string, IndexItem[]> {
	const byType = new Map<string, IndexItem[]>();

	for (const item of matches) {
		const group = byType.get(item.type) ?? [];
		group.push(item);
		byType.set(item.type, group);
	}

	return byType;
}

/**
 * Format pack titles as a colored suffix for list output.
 * @param item - Registry item whose packs should be shown.
 * @returns Pack suffix, or an empty string when the item has no packs.
 */
function formatPackSuffix(item: IndexItem): string {
	const packLabels = (item.packs ?? []).map((pack) => pack.title);
	return packLabels.length > 0 ? chalk.cyan(` [${packLabels.join(", ")}]`) : "";
}

/**
 * Print one type section with its items sorted by title.
 * @param type - Raw type value used when metadata has no label.
 * @param group - Items belonging to this type.
 * @param meta - Display metadata for the type.
 */
function printTypeGroup(
	type: string,
	group: IndexItem[],
	meta: RegistryItemTypeDefinition,
): void {
	console.log(primaryText(meta.label ?? type));
	if (meta.description) console.log(meta.description);
	console.log();

	const sorted = [...group].sort((a, b) => a.title.localeCompare(b.title));
	const indexWidth = String(sorted.length).length;

	for (const [index, item] of sorted.entries()) {
		const packs = formatPackSuffix(item);
		const number = defaultText(`${String(index + 1).padStart(indexWidth)}.`);

		console.log(
			`  ${number} ${chalk.bold(item.title)}${packs}: ${item.description}`,
		);
	}

	console.log();
}

/**
 * Print matching registry items grouped by type.
 * @param matches - Items to print.
 * @param typeOrder - Section order for types.
 * @param typeMeta - Display metadata keyed by type value.
 */
function printItemsByType(
	matches: IndexItem[],
	typeOrder: string[],
	typeMeta: Record<string, RegistryItemTypeDefinition>,
): void {
	const byType = groupItemsByType(matches);

	for (const type of typeOrder) {
		const group = byType.get(type);
		if (!group) continue;

		printTypeGroup(type, group, typeDefinition(type, typeMeta));
	}
}

/**
 * List registry items, optionally filtered by `--type`.
 * @param registry - Registry loaded at CLI registration time.
 * @param type - Optional CAC `--type` value (`string`, or `string[]` when repeated).
 */
export async function listCommand(
	registry: Registry,
	type?: TypeFilterOption,
): Promise<void> {
	assertItemTypesDeclared(registry);
	const itemTypes = Object.keys(registry.types);
	assertAllIsNotACatalogType(itemTypes);
	const allowedTypes = await typeFilterFromOption(
		type,
		itemTypes,
		registry.types,
	);
	const matches = Object.values(registry.items).filter((item) =>
		allowedTypes.has(item.type),
	);

	console.log();
	console.log(defaultText("─".repeat(40)));
	console.log();

	if (matches.length === 0) {
		console.log(defaultText("No registry items match the requested types."));
		console.log();
		return;
	}

	printItemsByType(matches, itemTypes, registry.types);

	console.log(defaultText(`${matches.length} item(s)`));
	console.log();
}
