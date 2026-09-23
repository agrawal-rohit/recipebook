import {
	assumeContextFromSelectedItems,
	buildInstallPlan,
	collectItemLocalConditions,
	collectRegistryDependencies,
	collectRequiredConditionWave,
	type HandlerRuntime,
	type IndexEntry,
	type InstallNode,
	inferConditionDefault,
	packWhenUsesCapturedKeys,
	policyForConditionKind,
	type Registry,
	RegistryConditionKind,
	type RegistryContext,
	type RegistryContextValue,
	type RegistryPackageManager,
	type RequiredCondition,
} from "@yoinker/core";
import { primaryText } from "../cli/labels";
import {
	confirmInput,
	multiselectInput,
	selectInput,
	textInput,
} from "../cli/prompts";
import { projectScriptHelpers } from "./scripts";

/**
 * Map condition values to Clack select/multiselect options.
 * @param condition - Condition whose labelled values become options.
 * @returns Options for a select or multiselect prompt.
 */
function conditionSelectOptions(
	condition: RequiredCondition,
): Array<{ label: string; value: string }> {
	return condition.values.map((entry) => ({
		label: entry.label,
		value: entry.value,
	}));
}

/**
 * Sole option value when a non-optional condition offers exactly one choice.
 * @param condition - Selectable condition about to be prompted.
 * @param optional - Whether the condition may be skipped.
 * @returns The single option value, or `undefined` when a prompt is required.
 */
function soleOptionValue(
	condition: RequiredCondition,
	optional: boolean,
): string | undefined {
	if (optional || condition.values.length !== 1) return undefined;
	return condition.values[0]?.value;
}

/**
 * Capture a multiselect condition via sole-option auto-select or a multiselect prompt.
 * @param condition - Multiselect condition to capture.
 * @param promptMessage - Message shown to the user.
 * @param inferred - Optional default from a condition handler.
 * @returns Selected values, or undefined when an optional prompt is left empty.
 */
async function promptMultiselectCondition(
	condition: RequiredCondition,
	promptMessage: string,
	inferred: RegistryContextValue | undefined,
): Promise<string[] | undefined> {
	const optional = condition.required !== true;
	const sole = soleOptionValue(condition, optional);
	if (sole !== undefined) return [sole];

	let defaultValues: string[] | undefined;
	if (Array.isArray(inferred)) defaultValues = inferred;

	const selected = await multiselectInput(
		promptMessage,
		{ options: conditionSelectOptions(condition) },
		defaultValues,
	);

	if (optional && selected.length === 0) return undefined;
	return selected;
}

/**
 * Reject a reserved skip value on an optional select condition.
 * @param condition - Select condition to validate.
 * @param skipValue - Reserved skip value.
 * @throws Error when the condition offers the reserved skip value.
 */
function assertNoReservedSkipValue(
	condition: RequiredCondition,
	skipValue: string,
): void {
	if (
		condition.required !== true &&
		condition.values.some((entry) => entry.value === skipValue)
	)
		throw new Error(
			`Condition "${condition.key}" value "${skipValue}" is reserved for skipping non-required selects.`,
		);
}

/**
 * Confirm an inferred select value with the user.
 * @param condition - Select condition being captured.
 * @param inferred - Value suggested by a condition handler.
 * @returns True when the user accepts the inferred value.
 */
async function confirmInferredSelectValue(
	condition: RequiredCondition,
	inferred: string,
): Promise<boolean> {
	const matchedOption = condition.values.find(
		(entry) => entry.value === inferred,
	);
	/* v8 ignore next -- inferConditionDefault only yields values present in options */
	if (!matchedOption) return false;

	const label = matchedOption.label || matchedOption.value;
	return confirmInput(
		`Detected ${primaryText(label)} for ${primaryText(condition.label)}. Use this?`,
		{},
		true,
	);
}

/**
 * Build select options, appending the skip choice for optional conditions.
 * @param condition - Select condition to offer.
 * @param skipValue - Reserved skip value appended when optional.
 * @returns Options for the select prompt.
 */
function selectOptionsWithSkip(
	condition: RequiredCondition,
	skipValue: string,
): Array<{ label: string; value: string }> {
	const options = conditionSelectOptions(condition);
	return condition.required !== true
		? [...options, { label: skipValue, value: skipValue }]
		: options;
}

/**
 * Capture a select condition via sole-option auto-select or a select prompt.
 * When a value was inferred by a condition handler, prompts for confirmation first and falls back to manual selection if the user declines.
 * @param condition - Select condition to capture.
 * @param promptMessage - Message shown to the user.
 * @param inferred - Optional default from a condition handler.
 * @returns Selected value, or undefined when the user chooses None on an optional condition.
 */
async function promptSelectCondition(
	condition: RequiredCondition,
	promptMessage: string,
	inferred: RegistryContextValue | undefined,
): Promise<string | undefined> {
	const skipValue = "None";
	assertNoReservedSkipValue(condition, skipValue);

	const sole = soleOptionValue(condition, condition.required !== true);
	if (sole !== undefined) return sole;

	if (
		typeof inferred === "string" &&
		(await confirmInferredSelectValue(condition, inferred))
	)
		return inferred;

	const selected = await selectInput<string>(
		promptMessage,
		{ options: selectOptionsWithSkip(condition, skipValue) },
		typeof inferred === "string" ? inferred : undefined,
	);

	if (condition.required !== true && selected === skipValue) return undefined;
	return selected;
}

/**
 * Capture an optional boolean via Yes / No / None (confirm cannot represent unset).
 * @param promptMessage - Message shown to the user.
 * @param inferred - Optional default from a condition handler.
 * @returns Captured boolean, or undefined when skipped.
 */
async function promptOptionalBooleanCondition(
	promptMessage: string,
	inferred: RegistryContextValue | undefined,
): Promise<boolean | undefined> {
	const selected = await selectInput<string>(
		promptMessage,
		{
			options: [
				{ label: "Yes", value: "true" },
				{ label: "No", value: "false" },
				{ label: "None", value: "None" },
			],
		},
		typeof inferred === "boolean" ? String(inferred) : undefined,
	);

	if (selected === "None") return undefined;
	return selected === "true";
}

/**
 * Prompt for a boolean condition, including optional skip handling.
 * @param promptMessage - User-facing prompt text.
 * @param optional - Whether the condition may be skipped.
 * @param inferred - Optional default from a condition handler.
 * @returns Captured boolean, or undefined when skipped.
 */
async function promptBooleanCondition(
	promptMessage: string,
	optional: boolean,
	inferred: RegistryContextValue | undefined,
): Promise<RegistryContextValue | undefined> {
	if (optional) return promptOptionalBooleanCondition(promptMessage, inferred);
	return confirmInput(
		promptMessage,
		{},
		typeof inferred === "boolean" ? inferred : undefined,
	);
}

/**
 * Prompt for a free-text condition, including optional skip handling.
 * @param promptMessage - User-facing prompt text.
 * @param optional - Whether the condition may be skipped.
 * @param inferred - Optional default from a condition handler.
 * @returns Captured text, or undefined when skipped.
 */
async function promptTextCondition(
	promptMessage: string,
	optional: boolean,
	inferred: RegistryContextValue | undefined,
): Promise<RegistryContextValue | undefined> {
	const value = await textInput(
		promptMessage,
		{ required: !optional },
		typeof inferred === "string" ? inferred : undefined,
	);
	if (optional && value === "") return undefined;
	return value;
}

/**
 * Prompt (or auto-select) a value for one condition.
 * @param condition - Condition the install plan still needs.
 * @param inferred - Optional default from a condition handler.
 * @returns Captured context value, or undefined when an optional condition is skipped.
 */
async function promptConditionValue(
	condition: RequiredCondition,
	inferred: RegistryContextValue | undefined,
): Promise<RegistryContextValue | undefined> {
	const optional = condition.required !== true;
	const promptMessage = condition.description ?? condition.label;
	const { kind } = policyForConditionKind(condition.kind);

	switch (kind) {
		case RegistryConditionKind.MULTISELECT:
			return promptMultiselectCondition(condition, promptMessage, inferred);
		case RegistryConditionKind.SELECT:
			return promptSelectCondition(condition, promptMessage, inferred);
		case RegistryConditionKind.BOOLEAN:
			return promptBooleanCondition(promptMessage, optional, inferred);
		case RegistryConditionKind.TEXT:
			return promptTextCondition(promptMessage, optional, inferred);
		/* v8 ignore start */
		// Stryker disable all: unreachable exhaustive default
		default: {
			const exhaustive: never = kind;
			throw new Error(`Unsupported condition kind: ${String(exhaustive)}`);
		}
		// Stryker restore all
		/* v8 ignore stop */
	}
}

/**
 * Whether a condition has only one legal value, so infer cannot change the answer.
 * @param condition - Condition about to be captured.
 * @returns True when the prompt will auto-select and ignore inferred defaults.
 */
function conditionValueIsDetermined(condition: RequiredCondition): boolean {
	if (condition.required !== true) return false;
	const { kind } = policyForConditionKind(condition.kind);
	switch (kind) {
		case RegistryConditionKind.SELECT:
		case RegistryConditionKind.MULTISELECT:
			return condition.values.length === 1;
		case RegistryConditionKind.BOOLEAN:
		case RegistryConditionKind.TEXT:
			return false;
		/* v8 ignore start */
		// Stryker disable all: unreachable exhaustive default
		default: {
			const exhaustive: never = kind;
			throw new Error(`Unsupported condition kind: ${String(exhaustive)}`);
		}
		// Stryker restore all
		/* v8 ignore stop */
	}
}

/**
 * Capture defaults and prompt for each pending condition, merging answers into context.
 * @param indexLocation - Absolute path or HTTPS URL of the index document.
 * @param conditions - Conditions still missing from context.
 * @param runtime - Shared handler runtime for condition inference.
 * @param context - Condition values already captured.
 * @returns Context including newly captured answers.
 */
async function captureConditionValues(
	indexLocation: string,
	conditions: RequiredCondition[],
	runtime: HandlerRuntime,
	context: RegistryContext,
	allowInfer: boolean,
): Promise<RegistryContext> {
	const next: RegistryContext = { ...context };

	for (const condition of conditions) {
		const inferred = !conditionValueIsDetermined(condition)
			? await inferConditionDefault(indexLocation, condition, runtime, next, {
					allowHandler: allowInfer,
				})
			: undefined;
		const value = await promptConditionValue(condition, inferred);
		if (value !== undefined) next[condition.key] = value;
	}

	return next;
}

/**
 * Capture remaining conditions until none are left to ask.
 * @param indexLocation - Absolute path or HTTPS URL of the index document.
 * @param runtime - Shared handler runtime for condition inference.
 * @param context - Condition values already captured.
 * @param collectPending - Returns conditions that are promptable for the current context.
 * @param afterBatch - Optional work after each capture batch (e.g. rebuild the install plan).
 * @param allowInfer - When false, skip infer handlers and keep schema `default`.
 * @returns Context after no further conditions remain.
 */
async function capturePendingConditions(
	indexLocation: string,
	runtime: HandlerRuntime,
	context: RegistryContext,
	collectPending: (context: RegistryContext) => RequiredCondition[],
	afterBatch?: (
		context: RegistryContext,
		capturedKeys: readonly string[],
	) => void,
	allowInfer = true,
): Promise<RegistryContext> {
	const askedKeys = new Set<string>();
	let next = context;
	const unread = (current: RegistryContext) =>
		collectPending(current).filter(
			(condition) => !askedKeys.has(condition.key),
		);
	let pending = unread(next);

	while (pending.length > 0) {
		for (const condition of pending) askedKeys.add(condition.key);
		next = await captureConditionValues(
			indexLocation,
			pending,
			runtime,
			next,
			allowInfer,
		);
		afterBatch?.(
			next,
			pending.map((condition) => condition.key),
		);
		pending = unread(next);
	}

	return next;
}

/**
 * Resolve install-plan nodes to catalog entries.
 * @param plan - Ordered install nodes.
 * @param registry - Loaded registry.
 * @returns Index entries in plan order.
 * @throws Error when a node names an item missing from the registry.
 */
function installEntriesForPlan(
	plan: InstallNode[],
	registry: Registry,
): IndexEntry[] {
	return plan.map((node) => {
		const item = registry.items[node.itemId];
		if (item === undefined)
			throw new Error(
				`Install plan references unknown registry item "${node.itemId}".`,
			);
		return { itemId: node.itemId, item };
	});
}

/**
 * Capture shared conditions until none remain promptable.
 * @param registry - Loaded registry.
 * @param indexLocation - Absolute path or HTTPS URL of the index document.
 * @param projectDir - Absolute project root.
 * @param items - Selected items (`id` or `id@pack`).
 * @param options - Runtime, package manager, infer policy, and optional seeded context.
 * @returns Captured condition context for pack selection.
 */
export async function captureRequiredConditions(
	registry: Registry,
	indexLocation: string,
	projectDir: string,
	items: string[],
	options: {
		runtime?: HandlerRuntime;
		packageManager?: RegistryPackageManager;
		allowInfer?: boolean;
		context?: RegistryContext;
	} = {},
): Promise<RegistryContext> {
	const runtime = options.runtime ?? projectScriptHelpers(projectDir);
	const { packageManager, allowInfer = true } = options;
	const context =
		options.context ??
		assumeContextFromSelectedItems(items, registry.items, registry.conditions);

	return capturePendingConditions(
		indexLocation,
		runtime,
		context,
		(current) => {
			const dependencies = collectRegistryDependencies(
				items,
				registry.items,
				current,
				packageManager,
			);
			return collectRequiredConditionWave(
				dependencies,
				registry.conditions,
				current,
				packageManager,
				items,
			);
		},
		undefined,
		allowInfer,
	);
}

/**
 * Capture item-local conditions for planned items, rebuilding the plan when answers change pack selection.
 * @param registry - Loaded registry.
 * @param indexLocation - Absolute path or HTTPS URL of the index document.
 * @param items - Selected items (`id` or `id@pack`).
 * @param plan - Ordered install nodes from the latest plan.
 * @param context - Shared conditions already captured.
 * @param runtime - Shared handler runtime.
 * @param options - Package manager and whether infer handlers may run.
 * @returns Context and plan after local conditions are settled.
 * @throws Error when a plan node names an item missing from the registry.
 */
export async function captureItemLocalConditionsForPlan(
	registry: Registry,
	indexLocation: string,
	items: string[],
	plan: InstallNode[],
	context: RegistryContext,
	runtime: HandlerRuntime,
	options: {
		packageManager?: RegistryPackageManager;
		allowInfer?: boolean;
	} = {},
): Promise<{ context: RegistryContext; plan: InstallNode[] }> {
	let nextPlan = plan;
	const { packageManager, allowInfer = true } = options;

	const nextContext = await capturePendingConditions(
		indexLocation,
		runtime,
		context,
		(current) =>
			collectItemLocalConditions(
				installEntriesForPlan(nextPlan, registry),
				current,
				packageManager,
				items,
			),
		(current, capturedKeys) => {
			const entries = installEntriesForPlan(nextPlan, registry);
			if (!packWhenUsesCapturedKeys(entries, capturedKeys)) return;
			nextPlan = buildInstallPlan(
				items,
				registry.items,
				current,
				packageManager,
			);
		},
		allowInfer,
	);

	return { context: nextContext, plan: nextPlan };
}
