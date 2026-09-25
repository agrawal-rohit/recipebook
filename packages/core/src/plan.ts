import {
	policyForConditionKind,
	RegistryConditionKind,
	type RegistryContext,
	type RegistryContextValue,
	type RegistryWhenValue,
} from "./condition-kind";
import {
	PACKAGE_MANAGER_KEY,
	type RegistryPackageManager,
	uniqueSorted,
} from "./packages";
import {
	type IndexItem,
	type IndexPack,
	InstallPhase,
	type Registry,
	type RegistryCondition,
	type RegistryConditionValue,
} from "./schema";
import type { DeclaredScriptUris } from "./scripts";
import { assertSinglePathSegment } from "./urls";

/**
 * Read an own property from a string-keyed record, ignoring Object.prototype.
 * @param record - Map that may be absent.
 * @param key - Property name.
 * @returns The own value, or undefined when the key is missing.
 */
function ownRecordValue<T>(
	record: Record<string, T> | undefined,
	key: string,
): T | undefined {
	return record !== undefined && Object.hasOwn(record, key)
		? record[key]
		: undefined;
}

/**
 * Reject item or pack tokens that would escape `r/` or pollute object lookup.
 * @param part - Id or pack id from `id` / `id@pack`.
 * @param kind - Which side of the token is being checked.
 * @throws Error when the token is `__proto__` or not a single path segment.
 */
function assertSafePlanToken(part: string, kind: "item" | "pack"): void {
	if (part === "__proto__")
		throw new Error(
			`${kind === "item" ? "Registry item id" : "Registry pack id"} "${part}" is not allowed.`,
		);
	assertSinglePathSegment(
		`${kind === "item" ? "Registry item id" : "Registry pack id"} "${part}"`,
		part,
	);
}

/**
 * Check whether a captured context value satisfies a `when` expectation.
 * @param actual - Captured context value for the condition key.
 * @param expected - Value from the item/pack `when` map.
 * @returns True when the expectation is satisfied.
 */
function contextValueMatchesWhen(
	actual: RegistryContextValue | undefined,
	expected: RegistryWhenValue,
): boolean {
	if (actual === undefined) return false;
	if (typeof expected === "boolean") return actual === expected;
	if (Array.isArray(actual)) {
		if (Array.isArray(expected))
			return expected.some((entry) => actual.includes(entry));
		return actual.includes(expected);
	}
	if (typeof actual === "boolean") return false;
	return Array.isArray(expected)
		? expected.includes(actual)
		: actual === expected;
}

/** Parsed item id, optionally with a pinned pack (`button` or `button@react`). */
export interface ParsedItemId {
	/** Registry item id. */
	id: string;
	/** Optional pinned pack id from `id@pack`. */
	packId?: string;
}

/** An index item with its selected compiled item source URIs. */
export interface InstallNode {
	/** Registry item id (index map key). */
	itemId: string;
	/** Selected pack ids whose compiled items should be layered on top of the base item. */
	packIds?: string[];
	/** Compiled item URIs from the index entry, joined against the index location when fetched. */
	sources?: string[];
	/** Compiled `beforeWrite` script URIs for this item. */
	beforeWriteScripts?: string[];
	/** Compiled `afterInstall` script URIs for this item. */
	afterInstallScripts?: string[];
}

/** Result of selecting installable sources (base and optional packs) for one index item. */
type RegistryItemSelection = Omit<InstallNode, "itemId">;

/** Index item id paired with its document for graph walks. */
export interface IndexEntry {
	/** Registry item id. */
	itemId: string;
	/** Index item document. */
	item: IndexItem;
}

/**
 * A condition the CLI still needs to capture before install can proceed.
 * Options are the intersection of declared condition values and values present
 * across the plan's packs, so prompts never offer uninstallable choices.
 */
export interface RequiredCondition {
	/** Condition key used by pack `when` entries. */
	key: string;
	/** Display label for prompts. */
	label: string;
	/** Optional longer description shown in the CLI. */
	description?: string;
	/** Prompt kind; defaults to select. */
	kind: RegistryConditionKind;
	/** Prompt options limited to values present on the install plan (select only). */
	values: RegistryConditionValue[];
	/** Compiled condition handler URI when the index declares one. */
	handler?: string;
	/** Default prompt value when the index declares one and no handler runs. */
	default?: RegistryContextValue;
	/** Whether the condition must receive a value; omitted means false. */
	required?: boolean;
}

/**
 * Check whether a `when` map matches the runtime context.
 * When `allowUndecided` is true, unset context keys are treated as undecided rather than mismatched.
 * @param when - Condition matcher from a index item, pack, or condition.
 * @param context - Condition values already captured for this install.
 * @param packageManager - Selected npm package manager for `when.packageManager`.
 * @param options - Match options; set `allowUndecided: true` for candidate walks.
 * @returns True when every evaluated `when` key satisfies the context value.
 */
export function whenMatchesContext(
	when: Record<string, RegistryWhenValue> | undefined,
	context: RegistryContext,
	packageManager?: RegistryPackageManager,
	options: { allowUndecided?: boolean } = {},
): boolean {
	if (!when) return true;
	for (const [key, expected] of Object.entries(when)) {
		const actual =
			key === PACKAGE_MANAGER_KEY
				? packageManager
				: ownRecordValue(context, key);
		if (options.allowUndecided && actual === undefined) continue;
		if (!contextValueMatchesWhen(actual, expected)) return false;
	}
	return true;
}

/** Item list fields merged from item-level and selected-pack declarations. */
type ItemListField = InstallPhase | "dependsOn";

/**
 * Collect item-level and selected-pack values for one list field.
 * @param item - Index item with optional packs.
 * @param packIds - Selected pack ids when packs exist.
 * @param field - List field to read (`beforeWrite`, `afterInstall`, or `dependsOn`).
 * @returns Combined entry list.
 */
function collectItemField<K extends ItemListField>(
	item: Pick<IndexItem, K | "packs">,
	packIds: string[],
	field: K,
): string[] {
	const selectedPacks =
		item.packs?.filter((entry) => packIds.includes(entry.id)) ?? [];
	return [
		...(item[field] ?? []),
		...selectedPacks.flatMap((entry) => entry[field] ?? []),
	];
}

/**
 * Attach compiled install script URIs to a selection result when present.
 * @param item - Index item that may declare lifecycle scripts.
 * @param selection - Selected pack ids and/or compiled item sources.
 * @returns Selection including script URIs when declared.
 */
function withItemScripts(
	item: IndexItem,
	selection: { packIds?: string[]; sources?: string[] },
): RegistryItemSelection {
	const packIds = selection.packIds ?? [];
	const beforeWrite = collectItemField(
		item,
		packIds,
		InstallPhase.BEFORE_WRITE,
	);
	const afterInstall = collectItemField(
		item,
		packIds,
		InstallPhase.AFTER_INSTALL,
	);
	return {
		...selection,
		...(beforeWrite.length > 0 ? { beforeWriteScripts: beforeWrite } : {}),
		...(afterInstall.length > 0 ? { afterInstallScripts: afterInstall } : {}),
	};
}

/**
 * Fail when a pack pin names a pack the item does not declare.
 * @param itemId - Registry item id for error messages.
 * @param item - Index item whose packs are checked.
 * @param pinnedPackId - Pack id from `id@pack`.
 * @throws Error when the item has no packs, or the pin is not a declared pack id.
 */
function assertPinnedPack(
	itemId: string,
	item: IndexItem,
	pinnedPackId: string,
): void {
	const packs = item.packs ?? [];
	if (packs.length === 0)
		throw new Error(`Registry item "${itemId}" has no packs.`);
	if (!packs.some((pack) => pack.id === pinnedPackId))
		throw new Error(`Registry item "${itemId}" has no pack "${pinnedPackId}".`);
}

/**
 * Select install sources for a pack-less index item.
 * @param itemId - Registry item id for error messages.
 * @param item - Index item without packs.
 * @param pinnedPackId - Must be undefined for pack-less items.
 * @returns Payload source and/or install script URIs.
 * @throws Error when a pack is pinned or the item has no installable source or phase entries.
 */
function selectPackLessItem(
	itemId: string,
	item: IndexItem,
	pinnedPackId?: string,
): RegistryItemSelection {
	if (pinnedPackId !== undefined) assertPinnedPack(itemId, item, pinnedPackId);
	// Scripts-only items (no compiled item source) are still installable.
	if (!item.source && !itemHasInstallPhases(item, []))
		throw new Error(
			`Registry item "${itemId}" is missing a compiled item source or install phase.`,
		);
	return withItemScripts(item, item.source ? { sources: [item.source] } : {});
}

/**
 * Select matching and/or pinned packs for one index item.
 * @param itemId - Registry item id for error messages.
 * @param item - Index item whose packs are being considered.
 * @param packs - Non-empty pack list from the index item.
 * @param context - Condition values already captured for this install.
 * @param pinnedPackId - Optional pack id from `id@pack`.
 * @param packageManager - Selected npm package manager for pack `when`.
 * @returns Base source plus every matching/pinned pack source.
 * @throws Error when a pinned pack id is missing, matching packs share a `when`,
 *   or no pack matches and the item has neither a base source nor install phases.
 */
function selectMatchingPacks(
	itemId: string,
	item: IndexItem,
	packs: NonNullable<IndexItem["packs"]>,
	context: RegistryContext,
	pinnedPackId: string | undefined,
	packageManager: RegistryPackageManager | undefined,
): RegistryItemSelection {
	if (pinnedPackId !== undefined) assertPinnedPack(itemId, item, pinnedPackId);
	const matchingPacks = packs.filter(
		(pack) =>
			pinnedPackId === pack.id ||
			whenMatchesContext(pack.when, context, packageManager),
	);
	assertPackedItemIsInstallable(itemId, item, matchingPacks);
	const sources = [
		...(item.source ? [item.source] : []),
		...matchingPacks.map((pack) => pack.source),
	];
	return withItemScripts(item, {
		...(matchingPacks.length > 0
			? { packIds: matchingPacks.map((pack) => pack.id) }
			: {}),
		...(sources.length > 0 ? { sources } : {}),
	});
}

/**
 * Whether an item declares beforeWrite or afterInstall scripts for the given packs.
 * @param item - Index item that may declare lifecycle scripts.
 * @param packIds - Selected pack ids; empty reads item-level scripts only.
 * @returns True when at least one install-phase script URI is present.
 */
function itemHasInstallPhases(item: IndexItem, packIds: string[]): boolean {
	return (
		collectItemField(item, packIds, InstallPhase.BEFORE_WRITE).length > 0 ||
		collectItemField(item, packIds, InstallPhase.AFTER_INSTALL).length > 0
	);
}

/**
 * Canonical JSON for a pack `when` map, so identical matchers compare equal.
 * @param when - Pack matcher; missing or empty is the unconditional identity.
 * @returns Stable JSON string of sorted `when` keys.
 */
function packWhenIdentity(
	when: Record<string, RegistryWhenValue> | undefined,
): string {
	if (!when) return "{}";
	const canonicalWhen: Record<string, RegistryWhenValue> = {};
	for (const key of Object.keys(when).sort((left, right) =>
		left.localeCompare(right),
	)) {
		const value = when[key];
		if (value !== undefined)
			canonicalWhen[key] = Array.isArray(value)
				? [...value].sort((left, right) => left.localeCompare(right))
				: value;
	}
	return JSON.stringify(canonicalWhen);
}

/**
 * Fail when two selected packs cannot be told apart by `when`.
 * Distinct matchers may still layer; identical matchers are a registry bug.
 * @param itemId - Registry item id for error messages.
 * @param packs - Packs already selected for this item.
 * @throws Error when more than one selected pack shares the same `when`.
 */
function assertSelectedPacksHaveDistinctWhen(
	itemId: string,
	packs: readonly IndexPack[],
): void {
	const idsByWhen = new Map<string, string[]>();
	for (const pack of packs) {
		const identity = packWhenIdentity(pack.when);
		const ids = idsByWhen.get(identity) ?? [];
		ids.push(pack.id);
		idsByWhen.set(identity, ids);
	}
	for (const ids of idsByWhen.values()) {
		if (ids.length < 2) continue;
		throw new Error(
			`Registry item "${itemId}" selected indistinguishable packs ${ids
				.map((id) => `"${id}"`)
				.join(", ")} (same when).`,
		);
	}
}

/**
 * Fail when pack selection would install nothing, or two packs share a `when`.
 * A base source with zero matching packs is valid (unconditional files, optional overlays).
 * @param itemId - Registry item id for error messages.
 * @param item - Index item whose packs were considered.
 * @param matchingPacks - Packs included by pin or matching `when`.
 * @throws Error when matching packs share a `when`, or none match and there is
 *   neither a base source nor item-level install phases.
 */
function assertPackedItemIsInstallable(
	itemId: string,
	item: IndexItem,
	matchingPacks: IndexPack[],
): void {
	assertSelectedPacksHaveDistinctWhen(itemId, matchingPacks);
	if (matchingPacks.length > 0) return;
	if (item.source || itemHasInstallPhases(item, [])) return;
	throw new Error(
		`Registry item "${itemId}" has packs but none match the current install context.`,
	);
}

/**
 * Select the matching packs for a index item under a runtime context.
 * @param itemId - Registry item id for error messages.
 * @param item - Index item whose packs are considered.
 * @param context - Condition values already captured for this install.
 * @param pinnedPackId - Optional explicit pack id (from `id@pack`).
 * @param packageManager - Selected npm package manager for pack `when`.
 * @returns Selected pack ids, compiled item source URIs, and optional install script URIs.
 */
function selectRegistryPacks(
	itemId: string,
	item: IndexItem,
	context: RegistryContext,
	pinnedPackId?: string,
	packageManager?: RegistryPackageManager,
): RegistryItemSelection {
	const packs = item.packs ?? [];
	if (packs.length === 0) return selectPackLessItem(itemId, item, pinnedPackId);
	return selectMatchingPacks(
		itemId,
		item,
		packs,
		context,
		pinnedPackId,
		packageManager,
	);
}

/**
 * Collect distinct string `when` values present on still-possible packs, keyed by condition name.
 * @param entries - Catalog entries in the install set.
 * @param selectedItems - Selected tokens (`id` or `id@pack`) used for pack pins.
 * @param context - Captured condition values so far.
 * @param packageManager - Selected npm package manager for pack `when`.
 * @returns Map of condition key → distinct `when` values present on still-possible packs.
 */
function collectPresentWhenValues(
	entries: IndexEntry[],
	selectedItems: readonly string[],
	context: RegistryContext,
	packageManager?: RegistryPackageManager,
): Map<string, Set<string>> {
	const present = new Map<string, Set<string>>();
	const pinnedPacks = pinnedPackIdsByItem(selectedItems);

	const addWhen = (
		when: Record<string, RegistryWhenValue> | undefined,
	): void => {
		if (!when) return;
		for (const [key, value] of Object.entries(when)) {
			// Registering the key matters even for booleans; strings narrow select options.
			let stringValues: string[] = [];
			if (Array.isArray(value)) stringValues = value;
			else if (typeof value === "string") stringValues = [value];
			const values = present.get(key) ?? new Set<string>();
			for (const entry of stringValues) values.add(entry);
			present.set(key, values);
		}
	};

	for (const { itemId, item } of entries) {
		const pinnedPackId = pinnedPacks.get(itemId);
		for (const pack of item.packs ?? []) {
			if (
				!packRelevantForCandidateWalk(
					pack,
					context,
					packageManager,
					pinnedPackId,
				)
			)
				continue;
			addWhen(pack.when);
		}
	}

	return present;
}

/**
 * Parse an item id string into an id and optional pack pin.
 * @param value - `id` or `id@packId`.
 * @returns Parsed item id.
 * @throws Error when the value is empty or malformed.
 */
export function parseItemId(value: string): ParsedItemId {
	if (value.length === 0)
		throw new Error("Registry item id must be non-empty.");

	const separatorIndex = value.indexOf("@");
	if (separatorIndex === -1) {
		assertSafePlanToken(value, "item");
		return { id: value };
	}
	if (separatorIndex === 0 || separatorIndex === value.length - 1)
		throw new Error(
			`Invalid registry item id "${value}" (expected id or id@pack).`,
		);

	const id = value.slice(0, separatorIndex);
	const packId = value.slice(separatorIndex + 1);
	if (packId.includes("@"))
		throw new Error(
			`Invalid registry item id "${value}" (expected id or id@pack).`,
		);
	assertSafePlanToken(id, "item");
	assertSafePlanToken(packId, "pack");
	return { id, packId };
}

/**
 * Drop duplicate requested item tokens (first wins) and fail if an id or pack pin is unknown.
 * @param items - Selected items (`id` or `id@pack`).
 * @param indexItems - Index items keyed by id.
 * @returns Unique requested tokens in original order.
 * @throws Error when a token is malformed, the item is missing, or a pack pin is invalid.
 */
export function uniqueKnownRegistryItems(
	items: readonly string[],
	indexItems: Record<string, IndexItem>,
): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const item of items) {
		if (seen.has(item)) continue;
		seen.add(item);
		const { id, packId } = parseItemId(item);
		const catalogItem = ownRecordValue(indexItems, id);
		if (!catalogItem) throw new Error(`Registry item not found: "${id}".`);
		if (packId !== undefined) assertPinnedPack(id, catalogItem, packId);
		unique.push(item);
	}

	return unique;
}

/**
 * Whether a pack's `dependsOn` should be included in the candidate closure.
 * Unknown `when` keys are ignored so still-undecided packs stay in the graph.
 * @param pack - Pack entry from the index item.
 * @param context - Captured condition values so far.
 * @param packageManager - Selected package manager for pack `when`.
 * @param pinnedPackId - Pack pin from a selected `id@pack` token for this item, if any.
 * @returns True when the pack is pinned, unconditional, still undecided, or already matching.
 */
function packRelevantForCandidateWalk(
	pack: IndexPack,
	context: RegistryContext,
	packageManager: RegistryPackageManager | undefined,
	pinnedPackId: string | undefined,
): boolean {
	if (pinnedPackId === pack.id) return true;
	return whenMatchesContext(pack.when, context, packageManager, {
		allowUndecided: true,
	});
}

/**
 * Index the first pinned pack for each selected item.
 * @param items - Selected item tokens (`id` or `id@pack`).
 * @returns Item ids mapped to their first pinned pack.
 */
function pinnedPackIdsByItem(items: readonly string[]): Map<string, string> {
	const pinned = new Map<string, string>();
	for (const item of items) {
		const parsed = parseItemId(item);
		if (parsed.packId !== undefined && !pinned.has(parsed.id))
			pinned.set(parsed.id, parsed.packId);
	}
	return pinned;
}

/**
 * Collect dependency ids for the candidate closure walk.
 * Item-level `dependsOn` is always included; pack `dependsOn` only from packs that may
 * still apply given the current context (pinned, matching, or undecided — not ruled out).
 * @param item - Index item being visited.
 * @param context - Captured condition values so far.
 * @param packageManager - Selected npm package manager for pack `when`.
 * @param pinnedPackId - Pack pin from a selected `id@pack` token for this item, if any.
 * @returns Unique referenced item ids.
 */
function collectCandidateDependencyIds(
	item: IndexItem,
	context: RegistryContext,
	packageManager: RegistryPackageManager | undefined,
	pinnedPackId: string | undefined,
): string[] {
	const referencedIds = new Set<string>();
	const addDeps = (entries: string[] | undefined): void => {
		for (const entry of entries ?? []) referencedIds.add(parseItemId(entry).id);
	};

	addDeps(item.dependsOn);
	for (const pack of item.packs ?? []) {
		if (
			packRelevantForCandidateWalk(pack, context, packageManager, pinnedPackId)
		)
			addDeps(pack.dependsOn);
	}
	return [...referencedIds];
}

/**
 * Collect selected items and transitive `dependsOn` entries that may still apply.
 * @param items - Selected items (`id` or `id@pack`).
 * @param indexItems - Index items keyed by id.
 * @param context - Install context used to skip packs that cannot match.
 * @param packageManager - Selected npm package manager for pack `when`.
 * @returns Unique index entries in discovery order (selected items first).
 * @throws Error when a listed item is missing from the index or a cycle is detected.
 */
export function collectRegistryDependencies(
	items: readonly string[],
	indexItems: Record<string, IndexItem>,
	context: RegistryContext = {},
	packageManager?: RegistryPackageManager,
): IndexEntry[] {
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const ordered: IndexEntry[] = [];
	const pinnedPacks = pinnedPackIdsByItem(items);

	const visit = (itemId: string): void => {
		if (visited.has(itemId)) return;
		if (visiting.has(itemId))
			throw new Error(`Registry dependency cycle detected at "${itemId}".`);

		const item = ownRecordValue(indexItems, itemId);
		if (!item) throw new Error(`Registry item not found: "${itemId}".`);

		visiting.add(itemId);
		ordered.push({ itemId, item });
		for (const dependencyId of collectCandidateDependencyIds(
			item,
			context,
			packageManager,
			pinnedPacks.get(itemId),
		))
			visit(dependencyId);
		visiting.delete(itemId);
		visited.add(itemId);
	};

	for (const item of items) visit(parseItemId(item).id);

	return ordered;
}

function addInferUri(uris: Set<string>, uri: string | undefined): void {
	if (uri) uris.add(uri);
}

function addMutationUris(
	uris: Set<string>,
	declared: string[] | undefined,
): void {
	for (const uri of declared ?? []) uris.add(uri);
}

/**
 * Add a shared condition handler when the condition is still possible.
 * @param infer - Infer URI set.
 * @param registry - Loaded registry document.
 * @param key - Shared condition key from `requires` or pack `when`.
 * @param context - Captured condition values so far.
 * @param packageManager - Selected npm package manager.
 */
function addSharedConditionHandler(
	infer: Set<string>,
	registry: Registry,
	key: string,
	context: RegistryContext,
	packageManager: RegistryPackageManager | undefined,
): void {
	if (key === PACKAGE_MANAGER_KEY) return;
	const condition = ownRecordValue(registry.conditions, key);
	if (!condition?.handler) return;
	if (
		!whenMatchesContext(condition.when, context, packageManager, {
			allowUndecided: true,
		})
	)
		return;
	addInferUri(infer, condition.handler);
}

/**
 * Collect infer and mutation URIs from one candidate index pack.
 * @param infer - Infer URI set.
 * @param mutation - Mutation URI set.
 * @param registry - Loaded registry document.
 * @param pack - Candidate index pack.
 * @param pinnedPackId - Pack pin for this item, if any.
 * @param context - Captured condition values so far.
 * @param packageManager - Selected npm package manager.
 */
function collectPackDeclaredScripts(
	infer: Set<string>,
	mutation: Set<string>,
	registry: Registry,
	pack: IndexPack,
	pinnedPackId: string | undefined,
	context: RegistryContext,
	packageManager: RegistryPackageManager | undefined,
): void {
	if (
		!packRelevantForCandidateWalk(pack, context, packageManager, pinnedPackId)
	)
		return;
	addMutationUris(mutation, pack.beforeWrite);
	addMutationUris(mutation, pack.afterInstall);
	for (const key of Object.keys(pack.when ?? {}))
		addSharedConditionHandler(infer, registry, key, context, packageManager);
}

/**
 * Collect infer and mutation URIs from one candidate index item.
 * @param infer - Infer URI set.
 * @param mutation - Mutation URI set.
 * @param registry - Loaded registry document.
 * @param item - Candidate index item.
 * @param pinnedPackId - Pack pin for this item, if any.
 * @param context - Captured condition values so far.
 * @param packageManager - Selected npm package manager.
 */
function collectItemDeclaredScripts(
	infer: Set<string>,
	mutation: Set<string>,
	registry: Registry,
	item: IndexItem,
	pinnedPackId: string | undefined,
	context: RegistryContext,
	packageManager: RegistryPackageManager | undefined,
): void {
	for (const key of item.requires ?? [])
		addSharedConditionHandler(infer, registry, key, context, packageManager);
	addMutationUris(mutation, item.beforeWrite);
	addMutationUris(mutation, item.afterInstall);

	for (const condition of Object.values(item.conditions ?? {})) {
		if (
			whenMatchesContext(condition.when, context, packageManager, {
				allowUndecided: true,
			})
		)
			addInferUri(infer, condition.handler);
	}

	for (const pack of item.packs ?? []) {
		collectPackDeclaredScripts(
			infer,
			mutation,
			registry,
			pack,
			pinnedPackId,
			context,
			packageManager,
		);
	}
}

/**
 * Collect catalog script URIs declared by candidate items, split into infer vs mutation.
 * Pack hooks and pack `when` handlers are included only when the pack is still possible.
 * Shared condition handlers are included from `requires` and from still-possible pack `when` keys.
 * @param registry - Loaded registry document.
 * @param itemIds - Candidate item ids (`id` or `id@pack`; prefixes are stripped to `id`).
 * @param options - Pin tokens, captured context, and selected package manager.
 * @returns Deduplicated infer and mutation script URIs.
 */
export function collectDeclaredScriptUris(
	registry: Registry,
	itemIds: readonly string[],
	options: {
		selectedItems?: readonly string[];
		context?: RegistryContext;
		packageManager?: RegistryPackageManager;
	} = {},
): DeclaredScriptUris {
	const infer = new Set<string>();
	const mutation = new Set<string>();
	const selectedItems = options.selectedItems ?? itemIds;
	const context = options.context ?? {};
	const { packageManager } = options;
	const pinnedPacks = pinnedPackIdsByItem(selectedItems);

	const selectedIds = new Set(itemIds.map((item) => parseItemId(item).id));
	for (const itemId of selectedIds) {
		const item = ownRecordValue(registry.items, itemId);
		if (!item) continue;
		collectItemDeclaredScripts(
			infer,
			mutation,
			registry,
			item,
			pinnedPacks.get(itemId),
			context,
			packageManager,
		);
	}

	return {
		infer: uniqueSorted([...infer]),
		mutation: uniqueSorted([...mutation]),
	};
}

/**
 * Whether a `when` map mentions the reserved package-manager key.
 * @param when - Pack or condition matcher.
 * @returns True when `packageManager` appears in the matcher.
 */
function whenUsesPackageManager(
	when: Record<string, RegistryWhenValue> | undefined,
): boolean {
	return when !== undefined && Object.hasOwn(when, PACKAGE_MANAGER_KEY);
}

/**
 * Whether a candidate item declares a package-manager dependency in its packs or condition when clauses.
 * @param item - Candidate index item to inspect.
 * @returns True when any pack or item-level condition when clause references the package manager key.
 */
function itemNeedsPackageManager(item: IndexItem): boolean {
	const packsNeed = (item.packs ?? []).some((pack) =>
		whenUsesPackageManager(pack.when),
	);
	if (packsNeed) return true;
	return Object.values(item.conditions ?? {}).some((condition) =>
		whenUsesPackageManager(condition.when),
	);
}

/**
 * Whether pack or condition `when` clauses in the candidate set need a package manager.
 * @param entries - Candidate index entries from {@link collectRegistryDependencies}.
 * @param conditions - Shared registry conditions (their `when` may also mention the manager).
 * @returns True when install planning should select a package manager now.
 */
export function catalogNeedsPackageManager(
	entries: IndexEntry[],
	conditions?: Record<string, RegistryCondition>,
): boolean {
	const sharedNeeds = Object.values(conditions ?? {}).some((condition) =>
		whenUsesPackageManager(condition.when),
	);
	if (sharedNeeds) return true;
	return entries.some(({ item }) => itemNeedsPackageManager(item));
}

/**
 * Whether the selected package manager can drop pack-level `dependsOn` from the candidate closure.
 * @param entries - Candidate index entries from a walk without a package manager.
 * @param items - Selected items (`id` or `id@pack`) used for pack pins.
 * @param context - Captured condition values so far (same as the first walk).
 * @param packageManager - Selected npm package manager.
 * @returns True when at least one still-possible pack with `dependsOn` would be ruled out.
 */
export function packageManagerDropsCandidateDependsOn(
	entries: IndexEntry[],
	items: readonly string[],
	context: RegistryContext,
	packageManager: RegistryPackageManager,
): boolean {
	const pinnedPacks = pinnedPackIdsByItem(items);
	for (const { itemId, item } of entries) {
		const pinnedPackId = pinnedPacks.get(itemId);
		for (const pack of item.packs ?? []) {
			if ((pack.dependsOn ?? []).length === 0) continue;
			if (!packRelevantForCandidateWalk(pack, context, undefined, pinnedPackId))
				continue;
			if (
				!packRelevantForCandidateWalk(
					pack,
					context,
					packageManager,
					pinnedPackId,
				)
			)
				return true;
		}
	}
	return false;
}

/**
 * Ensure a re-visit of an already-planned item does not pin a different pack.
 * @param id - Registry item id.
 * @param pinnedPackId - Pack pin from this edge, if any.
 * @param selectedPacks - Packs chosen on the first visit of each id.
 * @throws Error when the pin conflicts with the earlier selection.
 */
function assertCompatibleRevisit(
	id: string,
	pinnedPackId: string | undefined,
	selectedPacks: Map<string, string[] | undefined>,
): void {
	if (pinnedPackId === undefined) return;
	if (selectedPacks.get(id)?.includes(pinnedPackId)) return;
	throw new Error(`Registry item "${id}" selected conflicting packs.`);
}

/** Mutable state shared while walking the install dependency graph. */
interface InstallPlanState {
	visiting: Set<string>;
	visited: Set<string>;
	ordered: InstallNode[];
	selectedPacks: Map<string, string[] | undefined>;
}

/**
 * Visit one item in the install dependency graph and append it to the plan.
 * @param parsed - Parsed item id, optionally pinned to one pack.
 * @param indexItems - Index items keyed by id.
 * @param context - Install context for pack selection.
 * @param packageManager - Selected npm package manager for pack `when`.
 * @param state - Shared visit state for cycle detection and ordering.
 * @throws Error when an item is missing, a cycle is detected, or pack pins conflict.
 */
function visitInstallNode(
	parsed: ParsedItemId,
	indexItems: Record<string, IndexItem>,
	context: RegistryContext,
	packageManager: RegistryPackageManager | undefined,
	state: InstallPlanState,
): void {
	const { id, packId: pinnedPackId } = parsed;

	if (state.visited.has(id)) {
		assertCompatibleRevisit(id, pinnedPackId, state.selectedPacks);
		return;
	}

	if (state.visiting.has(id))
		throw new Error(`Registry dependency cycle detected at "${id}".`);

	const catalogItem = ownRecordValue(indexItems, id);
	if (!catalogItem) throw new Error(`Registry item not found: "${id}".`);

	state.visiting.add(id);
	const selection = selectRegistryPacks(
		id,
		catalogItem,
		context,
		pinnedPackId,
		packageManager,
	);

	for (const dependency of collectItemField(
		catalogItem,
		selection.packIds ?? [],
		"dependsOn",
	))
		visitInstallNode(
			parseItemId(dependency),
			indexItems,
			context,
			packageManager,
			state,
		);

	state.visiting.delete(id);
	state.visited.add(id);
	state.selectedPacks.set(id, selection.packIds);
	state.ordered.push({ itemId: id, ...selection });
}

/**
 * Build a prompt-ready required condition entry.
 * @param key - Condition key.
 * @param condition - Shared condition definition.
 * @param kind - Effective prompt kind.
 * @param values - Prompt options (empty for text/boolean).
 * @returns Required condition for the CLI.
 */
function buildRequiredCondition(
	key: string,
	condition: RegistryCondition,
	kind: RegistryConditionKind,
	values: RegistryConditionValue[],
): RequiredCondition {
	const requiredCondition: RequiredCondition = {
		key,
		label: condition.label,
		kind,
		values,
	};
	if (condition.description)
		requiredCondition.description = condition.description;
	if (condition.handler) requiredCondition.handler = condition.handler;
	if (condition.default) requiredCondition.default = condition.default;
	if (condition.required === true) requiredCondition.required = true;
	return requiredCondition;
}

/**
 * Prompt options for a required select condition, narrowed to values present on the install set.
 * @param key - Condition key.
 * @param condition - Shared condition definition.
 * @param presentWhenValues - Distinct `when` values present on the install set.
 * @returns Selectable condition values for the CLI prompt.
 * @throws Error when no selectable values remain.
 */
function selectableValuesForCondition(
	key: string,
	condition: RegistryCondition,
	presentWhenValues: Map<string, Set<string>>,
): RegistryConditionValue[] {
	const present = presentWhenValues.get(key);
	const declaredValues = condition.values ?? [];
	const values = present
		? declaredValues.filter((entry) => present.has(entry.value))
		: declaredValues;
	if (values.length === 0)
		throw new Error(
			`Condition "${key}" has no selectable values for the current install set.`,
		);
	return values;
}

/**
 * Collect conditions still missing from the context, with prompt-ready options.
 * Includes keys from pack `when` and from item-level `requires` lists.
 * Skips `packageManager`, which is selected by core at install time.
 * @param entries - Catalog entries in the install set.
 * @param conditions - Shared condition definitions from the registry.
 * @param context - Condition values already captured.
 * @param packageManager - Selected npm package manager for condition `when` clauses.
 * @param selectedItems - Selected tokens (`id` or `id@pack`) used for pack pins.
 * @returns Required conditions the CLI should prompt for, sorted by key.
 */
export function collectRequiredConditions(
	entries: IndexEntry[],
	conditions: Record<string, RegistryCondition> | undefined,
	context: RegistryContext,
	packageManager?: RegistryPackageManager,
	selectedItems: readonly string[] = [],
): RequiredCondition[] {
	const presentWhenValues = collectPresentWhenValues(
		entries,
		selectedItems,
		context,
		packageManager,
	);
	const requiredKeys = new Set<string>(presentWhenValues.keys());
	for (const { item } of entries) {
		for (const key of item.requires ?? []) requiredKeys.add(key);
	}

	const required: RequiredCondition[] = [];

	for (const key of [...requiredKeys].sort((a, b) => a.localeCompare(b))) {
		if (ownRecordValue(context, key) !== undefined) continue;
		// Runtime matcher owned by core — not a registry condition to prompt.
		if (key === PACKAGE_MANAGER_KEY) continue;

		const condition = ownRecordValue(conditions, key);
		if (!condition)
			throw new Error(`Install plan references undeclared condition "${key}".`);

		// Prompt only when the condition's own `when` is absent or already satisfied.
		if (!whenMatchesContext(condition.when, context, packageManager)) continue;

		const { kind, requiresValues } = policyForConditionKind(condition.kind);
		const values = requiresValues
			? selectableValuesForCondition(key, condition, presentWhenValues)
			: [];
		required.push(buildRequiredCondition(key, condition, kind, values));
	}

	return required;
}

/**
 * Next shared-condition wave: all pending item `requires` first, then one pack-`when` key.
 * Asking requires first lets later harvests drop when-keys from packs that no longer apply.
 * @param entries - Catalog entries in the install set.
 * @param conditions - Shared condition definitions from the registry.
 * @param context - Condition values already captured.
 * @param packageManager - Selected npm package manager for condition `when` clauses.
 * @param selectedItems - Selected tokens (`id` or `id@pack`) used for pack pins.
 * @returns Conditions to capture in this prompt batch.
 */
export function collectRequiredConditionWave(
	entries: IndexEntry[],
	conditions: Record<string, RegistryCondition> | undefined,
	context: RegistryContext,
	packageManager?: RegistryPackageManager,
	selectedItems: readonly string[] = [],
): RequiredCondition[] {
	const pending = collectRequiredConditions(
		entries,
		conditions,
		context,
		packageManager,
		selectedItems,
	);
	const requireKeys = new Set<string>();
	for (const { item } of entries)
		for (const key of item.requires ?? []) requireKeys.add(key);

	const fromRequires = pending.filter((condition) =>
		requireKeys.has(condition.key),
	);
	if (fromRequires.length > 0) return fromRequires;
	return pending.slice(0, 1);
}

/**
 * Collect item-level conditions still missing from context.
 * Select options are narrowed to values present on still-possible pack `when` maps.
 * @param entries - Planned index entries (install set).
 * @param context - Condition values already captured (shared + prior items).
 * @param packageManager - Selected npm package manager for condition `when` clauses.
 * @param selectedItems - Selected tokens (`id` or `id@pack`) used for pack pins.
 * @returns Conditions to prompt for, sorted by key.
 * @throws Error when a local select has no remaining values for the install set.
 */
export function collectItemLocalConditions(
	entries: IndexEntry[],
	context: RegistryContext,
	packageManager?: RegistryPackageManager,
	selectedItems: readonly string[] = [],
): RequiredCondition[] {
	const pending = new Map<string, RegistryCondition>();

	for (const { item } of entries) {
		const local = item.conditions;
		if (!local) continue;

		for (const [key, condition] of Object.entries(local)) {
			if (ownRecordValue(context, key) !== undefined) continue;
			// Prompt only when the condition's own `when` is absent or already satisfied.
			if (!whenMatchesContext(condition.when, context, packageManager))
				continue;
			pending.set(key, condition);
		}
	}

	const presentWhenValues = collectPresentWhenValues(
		entries,
		selectedItems,
		context,
		packageManager,
	);

	return [...pending.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, condition]) => {
			const { kind, requiresValues } = policyForConditionKind(condition.kind);
			const values = requiresValues
				? selectableValuesForCondition(key, condition, presentWhenValues)
				: [];
			return buildRequiredCondition(key, condition, kind, values);
		});
}

/**
 * Whether any pack on the planned items names one of the captured keys in `when`.
 * Interpolation-only locals do not appear here, so the install plan need not rebuild.
 * @param entries - Planned index entries.
 * @param capturedKeys - Condition keys captured in the latest prompt batch.
 * @returns True when a captured key can change pack selection or `dependsOn`.
 */
export function packWhenUsesCapturedKeys(
	entries: IndexEntry[],
	capturedKeys: readonly string[],
): boolean {
	if (capturedKeys.length === 0) return false;
	const keys = new Set(capturedKeys);
	for (const { item } of entries) {
		for (const pack of item.packs ?? []) {
			if (pack.when && Object.keys(pack.when).some((key) => keys.has(key)))
				return true;
		}
	}
	return false;
}

/**
 * Seed one condition from a pinned pack and reject conflicting scalar values.
 * @param context - Context being built from selected pack pins.
 * @param key - Condition key being seeded.
 * @param value - Matcher value from the pinned pack.
 * @param condition - Declared condition for the key.
 * @param pinLabel - Pinned item token for error messages.
 * @throws Error when scalar pinned packs require conflicting values.
 */
function seedPinnedCondition(
	context: RegistryContext,
	key: string,
	value: RegistryWhenValue,
	condition: RegistryCondition,
	pinLabel: string,
): void {
	const policy = policyForConditionKind(condition.kind);
	const existing = ownRecordValue(context, key);
	if (
		existing !== undefined &&
		policy.kind !== RegistryConditionKind.MULTISELECT &&
		!contextValueMatchesWhen(existing, value)
	)
		throw new Error(
			`Pinned pack "${pinLabel}" requires a conflicting value for condition "${key}".`,
		);
	policy.seedContext(context, key, value);
}

/**
 * Seed condition values from a pinned pack when map.
 * @param context - Context being populated.
 * @param when - Pinned pack when map.
 * @param catalogItem - Declaring catalog item.
 * @param conditions - Shared condition definitions.
 * @param pinLabel - Item@pack label for error reporting.
 * @throws Error when a condition referenced in when is undeclared.
 */
function seedPinnedPackWhen(
	context: RegistryContext,
	when: Record<string, RegistryWhenValue>,
	catalogItem: IndexItem,
	conditions: Record<string, RegistryCondition> | undefined,
	pinLabel: string,
): void {
	for (const [key, value] of Object.entries(when)) {
		if (key === PACKAGE_MANAGER_KEY) continue;
		const condition =
			ownRecordValue(conditions, key) ??
			ownRecordValue(catalogItem.conditions, key);
		if (!condition)
			throw new Error(
				`Pinned pack "${pinLabel}" references undeclared condition "${key}".`,
			);
		seedPinnedCondition(context, key, value, condition, pinLabel);
	}
}

/**
 * Seed context from pinned pack `when` maps on selected items.
 * Does not seed `packageManager` — that value is selected by core at install time.
 * @param items - Selected items (`id` or `id@pack`).
 * @param indexItems - Index items keyed by id.
 * @param conditions - Shared condition definitions; item-local conditions fill gaps.
 * @returns Partial context derived from pinned pack conditions.
 */
export function assumeContextFromSelectedItems(
	items: readonly string[],
	indexItems: Record<string, IndexItem>,
	conditions?: Record<string, RegistryCondition>,
): RegistryContext {
	const context: RegistryContext = {};
	for (const item of items) {
		const { id, packId } = parseItemId(item);
		if (packId === undefined) continue;

		const catalogItem = ownRecordValue(indexItems, id);
		if (!catalogItem) throw new Error(`Registry item not found: "${id}".`);

		const when = catalogItem.packs?.find((entry) => entry.id === packId)?.when;
		if (when) {
			seedPinnedPackWhen(
				context,
				when,
				catalogItem,
				conditions,
				`${id}@${packId}`,
			);
		}
	}

	return context;
}

/**
 * Build an ordered install plan from selected items and transitive dependsOn.
 * @param items - Selected registry items (`id` or `id@pack`).
 * @param indexItems - Index items keyed by id.
 * @param context - Install context for pack selection.
 * @param packageManager - Selected npm package manager for pack `when`.
 * @returns Ordered install nodes with base and matching pack sources per item id.
 * @throws Error when an item is missing, a cycle is detected, or pack pins conflict.
 */
export function buildInstallPlan(
	items: readonly string[],
	indexItems: Record<string, IndexItem>,
	context: RegistryContext,
	packageManager?: RegistryPackageManager,
): InstallNode[] {
	const state: InstallPlanState = {
		visiting: new Set<string>(),
		visited: new Set<string>(),
		ordered: [],
		selectedPacks: new Map<string, string[] | undefined>(),
	};

	for (const item of items)
		visitInstallNode(
			parseItemId(item),
			indexItems,
			context,
			packageManager,
			state,
		);

	return state.ordered;
}
