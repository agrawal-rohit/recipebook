/**
 * Browser-safe surface for clients that only need parse / plan helpers.
 * Intentionally omits build, scripts, handlers, and shell (Node / esbuild).
 */

export {
	type ConditionKindPolicy,
	policyForConditionKind,
	RegistryConditionKind,
	type RegistryContext,
	type RegistryContextValue,
	type RegistryWhenValue,
} from "./condition-kind";
export {
	NpmPackageManager,
	PACKAGE_MANAGER_KEY,
	type RegistryPackageManager,
} from "./packages";
export { parseRegistryDocument, parseWithSchema } from "./parse";
export {
	assumeContextFromSelectedItems,
	buildInstallPlan,
	catalogNeedsPackageManager,
	collectItemLocalConditions,
	collectRegistryDependencies,
	collectRequiredConditions,
	type IndexEntry,
	type InstallNode,
	parseItemId,
	uniqueKnownRegistryItems,
} from "./plan";
export type { IndexItem, Registry } from "./schema";
